import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { observabilityRequest, poll } from "@lab/kube";
import { helmApp, type ClusterAccess } from "@lab/kubernetes";

// SUSE Observability agents (DESIGN.md §9.6): each registered with its instance as its CLI does it
// (`sts rbac create-subject`, `sts rbac grant`, `sts service-token create`), through the REST API,
// with a service token of its own the agent reports with, and its cluster's instance of the
// kubernetes-v2 StackPack (`sts stackpack install --name kubernetes-v2 -p kubernetes_cluster_name=…`).

/** The StackPack every agent's cluster gets an instance of. */
const STACKPACK = "kubernetes-v2";
/** The StackPack for Harvesters: one instance for all of them, without parameters. */
const VIRTUALIZATION = "suse-virtualization";

export interface ObservabilityRegistrationArgs {
    /** The instance: `https://observability.<cluster>.<domain>`. */
    url: pulumi.Input<string>;
    /** A service token with admin rights (the instance's bootstrap token). */
    adminToken: pulumi.Input<string>;
    /** The agent's subject and token name: `agent-<cluster name>`. */
    subject: string;
    /** The cluster's name as the agent reports it: its kubernetes-v2 StackPack instance (`kubernetes_cluster_name`). */
    clusterName: string;
    /** A Harvester: the suse-virtualization StackPack too (one instance, shared by all Harvesters). */
    virtualization?: boolean;
    /** Let's Encrypt staging: don't check the instance's certificate. */
    insecure: boolean;
    /** How long to wait for the instance's API to answer (Fleet installs it in its own time). */
    timeoutSeconds: number;
}

interface Inputs {
    url: string;
    adminToken: string;
    subject: string;
    clusterName: string;
    virtualization?: boolean;
    insecure: boolean;
    timeoutSeconds: number;
}

interface Outputs extends Inputs {
    /** The agent's service token: what it reports with. */
    token: string;
    /** Its kubernetes-v2 StackPack instance. */
    stackPackInstance?: number;
    /** The suse-virtualization StackPack instance (a Harvester's), when it's ensured. */
    virtualizationInstance?: number;
}

const describe = (res: { status: number; body: any }) => {
    const message = typeof res.body === "string" ? res.body.slice(0, 200) : res.body?.message ?? res.body?.errors?.[0]?.message;
    return `HTTP ${res.status}${message ? `: ${message}` : ""}`;
};

/** How long a rejected admin token or license is retried: Fleet rolling the instance out with a new one. */
const REJECTED_GRACE_MS = 15 * 60 * 1000;

/**
 * Wait until the instance answers its API with the admin token. Until Fleet has installed it, its
 * name doesn't resolve or its ingress answers 404/5xx. A 401 or 403 is retried for a while too:
 * right after the token changes, Fleet is still upgrading the instance with it ("Service Token …
 * is unknown"); if it keeps being rejected, the token is wrong.
 */
async function waitForApi(i: Inputs): Promise<void> {
    let rejectedSince: number | undefined;
    await poll(async seen => {
        try {
            const res = await observabilityRequest(i, i.adminToken, "GET", "/security/tokens");
            if (res.status === 200) return true;
            const last = describe(res);
            seen(last);
            // 401/403: the token is wrong, or not there yet; 402: no valid license ("Your SUBSCRIPTION
            // is expired"), or the old one until Fleet has redeployed with a new one.
            if (res.status === 401 || res.status === 402 || res.status === 403) {
                rejectedSince ??= Date.now();
                if (Date.now() - rejectedSince > Math.min(REJECTED_GRACE_MS, i.timeoutSeconds * 1000 / 2)) {
                    throw Object.assign(new Error(res.status === 402
                        ? `SUSE Observability at ${i.url} keeps refusing its API (${last}): check its license (fleet-secrets' suse-observability-license input), and that Fleet has redeployed it`
                        : `SUSE Observability at ${i.url} keeps rejecting the admin token (${last}): is it the instance's bootstrap token (fleet-secrets' suse-observability-token input), and has Fleet upgraded the instance with it?`), { fatal: true });
                }
            } else {
                rejectedSince = undefined;
            }
        } catch (e) {
            if ((e as { fatal?: boolean }).fatal) throw e;
            seen((e as Error).message);
        }
        return undefined;
    }, {
        timeoutSeconds: i.timeoutSeconds, everyMs: Math.min(10000, i.timeoutSeconds * 200),
        failure: last => `timed out after ${i.timeoutSeconds}s waiting for SUSE Observability's API at ${i.url} (last: ${last})`,
    });
}

/** The id of the cluster's kubernetes-v2 StackPack instance, if it has one. */
async function stackPackInstanceOf(i: Inputs): Promise<number | undefined> {
    const res = await observabilityRequest(i, i.adminToken, "GET", "/stackpack");
    if (res.status !== 200) throw new Error(`listing StackPacks failed: ${describe(res)}`);
    const pack = (res.body as { name: string; configurations?: { id?: number; config?: Record<string, unknown> }[] }[]).find(p => p.name === STACKPACK);
    if (!pack) throw new Error(`SUSE Observability at ${i.url} has no ${STACKPACK} StackPack`);
    return pack.configurations?.find(c => c.config?.kubernetes_cluster_name === i.clusterName)?.id;
}

/**
 * The cluster's kubernetes-v2 StackPack instance: the one it has, or a new one
 * (`sts stackpack install --name kubernetes-v2 -p kubernetes_cluster_name=<name> --unlocked-strategy fail`).
 */
async function ensureStackPack(i: Inputs): Promise<number> {
    const existing = await stackPackInstanceOf(i);
    if (existing !== undefined) return existing;
    const res = await observabilityRequest(i, i.adminToken, "POST", `/stackpack/${STACKPACK}/provision?unlocked=fail`, { kubernetes_cluster_name: i.clusterName });
    if (res.status >= 300 || res.body?.id === undefined) throw new Error(`installing the ${STACKPACK} StackPack for ${i.clusterName} failed: ${describe(res)}`);
    return res.body.id;
}

/**
 * The suse-virtualization StackPack's instance: the one there is, or a new one (it has no parameters,
 * and one serves every Harvester).
 */
async function ensureVirtualization(i: Inputs): Promise<number> {
    const res = await observabilityRequest(i, i.adminToken, "GET", "/stackpack");
    if (res.status !== 200) throw new Error(`listing StackPacks failed: ${describe(res)}`);
    const pack = (res.body as { name: string; configurations?: { id?: number }[] }[]).find(p => p.name === VIRTUALIZATION);
    if (!pack) throw new Error(`SUSE Observability at ${i.url} has no ${VIRTUALIZATION} StackPack`);
    const existing = pack.configurations?.find(c => c.id !== undefined)?.id;
    if (existing !== undefined) return existing;
    const installed = await observabilityRequest(i, i.adminToken, "POST", `/stackpack/${VIRTUALIZATION}/provision?unlocked=fail`, {});
    if (installed.status >= 300 || installed.body?.id === undefined) throw new Error(`installing the ${VIRTUALIZATION} StackPack failed: ${describe(installed)}`);
    return installed.body.id;
}

/** The ids of the service tokens named after the agent's subject. */
async function tokensOf(i: Inputs): Promise<number[]> {
    const res = await observabilityRequest(i, i.adminToken, "GET", "/security/tokens");
    if (res.status !== 200) throw new Error(`listing service tokens failed: ${describe(res)}`);
    return (res.body as { id?: number; name: string }[]).filter(t => t.name === i.subject && t.id !== undefined).map(t => t.id!);
}

/** Exported for its tests. */
export const registrationProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        await waitForApi(inputs);
        const subject = encodeURIComponent(inputs.subject);
        // sts rbac create-subject --subject agent-<name>
        const created = await observabilityRequest(inputs, inputs.adminToken, "PUT", `/security/subjects/${subject}`, {});
        if (created.status >= 300 && created.status !== 409) throw new Error(`creating subject ${inputs.subject} failed: ${describe(created)}`);
        // sts rbac grant --subject agent-<name> --permission update-metrics (on the system resource, the CLI's default)
        const granted = await observabilityRequest(inputs, inputs.adminToken, "POST", `/security/permissions/${subject}`, { permission: "update-metrics", resourceName: "system" });
        if (granted.status >= 300) throw new Error(`granting update-metrics to ${inputs.subject} failed: ${describe(granted)}`);
        // A token is only shown when it's made: one left from an earlier, failed attempt goes first.
        for (const id of await tokensOf(inputs)) await observabilityRequest(inputs, inputs.adminToken, "DELETE", `/security/tokens/${id}`);
        // sts service-token create --name agent-<name> --roles agent-<name>
        const token = await observabilityRequest(inputs, inputs.adminToken, "POST", "/security/tokens", { name: inputs.subject, roles: [inputs.subject] });
        if (token.status >= 300 || !token.body?.token) throw new Error(`creating service token ${inputs.subject} failed: ${describe(token)}`);
        const outs: Outputs = {
            ...inputs, token: token.body.token, stackPackInstance: await ensureStackPack(inputs),
            ...(inputs.virtualization ? { virtualizationInstance: await ensureVirtualization(inputs) } : {}),
        };
        return { id: `${inputs.url}/${inputs.subject}`, outs };
    },

    async diff(_id: string, olds: Outputs, news: Inputs) {
        // Another instance or name is another registration; a new admin token or timeout isn't.
        // One registered before agents got a StackPack instance gets one in place.
        const replaces = (["url", "subject", "clusterName"] as const).filter(k => olds[k] !== news[k] && !(k === "clusterName" && olds[k] === undefined));
        const changes = replaces.length > 0 || olds.stackPackInstance === undefined || !!olds.virtualization !== !!news.virtualization
            || olds.adminToken !== news.adminToken || olds.insecure !== news.insecure || olds.timeoutSeconds !== news.timeoutSeconds;
        return { changes, replaces, deleteBeforeReplace: true };
    },

    async update(_id: string, olds: Outputs, news: Inputs) {
        const virtualization = news.virtualization && olds.virtualizationInstance === undefined;
        if (olds.stackPackInstance === undefined || virtualization) await waitForApi(news);
        // Turned off, the shared suse-virtualization instance stays: other Harvesters may report through it.
        return { outs: {
            ...news, token: olds.token, stackPackInstance: olds.stackPackInstance ?? await ensureStackPack(news),
            ...(news.virtualization ? { virtualizationInstance: olds.virtualizationInstance ?? await ensureVirtualization(news) } : {}),
        } };
    },

    /**
     * Uninstall its kubernetes-v2 StackPack instance, delete its service tokens and its subject. The
     * shared suse-virtualization instance stays (other Harvesters may report through it). An instance that's
     * gone or doesn't answer (the lab is being destroyed, its cluster with it) has nothing left to
     * clean up: that's skipped.
     */
    async delete(_id: string, props: Outputs) {
        try {
            const probe = await observabilityRequest(props, props.adminToken, "GET", "/security/tokens", undefined, 15000);
            if (probe.status !== 200) {
                pulumi.log.warn(`SUSE Observability at ${props.url} answers ${describe(probe)}; not cleaning up ${props.subject} there`);
                return;
            }
        } catch (e) {
            pulumi.log.warn(`SUSE Observability at ${props.url} can't be reached (${(e as Error).message}); not cleaning up ${props.subject} there`);
            return;
        }
        const instance = props.clusterName ? await stackPackInstanceOf(props) : undefined;
        if (instance !== undefined) {
            const res = await observabilityRequest(props, props.adminToken, "POST", `/stackpack/${STACKPACK}/deprovision/${instance}`);
            if (res.status >= 300 && res.status !== 404) throw new Error(`uninstalling the ${STACKPACK} StackPack of ${props.clusterName} failed: ${describe(res)}`);
        }
        for (const id of await tokensOf(props)) {
            const res = await observabilityRequest(props, props.adminToken, "DELETE", `/security/tokens/${id}`);
            if (res.status >= 300 && res.status !== 404) throw new Error(`deleting service token ${props.subject} failed: ${describe(res)}`);
        }
        const res = await observabilityRequest(props, props.adminToken, "DELETE", `/security/subjects/${encodeURIComponent(props.subject)}`);
        if (res.status >= 300 && res.status !== 404) throw new Error(`deleting subject ${props.subject} failed: ${describe(res)}`);
    },
};

/** An agent's registration with a SUSE Observability instance: its subject, permission and service token. */
export class ObservabilityRegistration extends pulumi.dynamic.Resource {
    /** The agent's service token (secret). */
    declare readonly token: pulumi.Output<string>;

    constructor(name: string, args: ObservabilityRegistrationArgs, opts?: pulumi.CustomResourceOptions) {
        super(registrationProvider, name, { ...args, token: undefined }, { ...opts, additionalSecretOutputs: ["token", "adminToken"] }, "lab", "ObservabilityRegistration");
    }
}

/** The Secret the agent reads its token from (`global.apiKey.fromSecret`), and the chart's values. */
export const AGENT_SECRET = "suse-observability-agent-key";

/**
 * The agent chart's values: where to report, as which cluster, its token from AGENT_SECRET. On a
 * Harvester, its OpenTelemetry integrations too: SUSE Virtualization, and Rancher's agent when it's
 * imported into a Rancher.
 */
export function agentValues(url: string, clusterName: string, harvester?: { rancherAgent: boolean }): Record<string, unknown> {
    return {
        stackstate: { url: `${url.replace(/\/+$/, "")}/receiver/stsAgent`, cluster: { name: clusterName } },
        global: { apiKey: { fromSecret: AGENT_SECRET } },
        ...(harvester ? { otel: { enabled: true, integrations: { suseVirtualization: true, rancherAgent: harvester.rancherAgent } } } : {}),
    };
}

export interface ObservabilityAgentArgs {
    cluster: Pick<ClusterAccess, "provider" | "deletedWith">;
    chart: { chart: string; repo?: string; version: string; namespace: string };
    url: string;
    clusterName: string;
    /** The agent's service token. */
    token: pulumi.Input<string>;
    /** The lab's own chart values, under the engine's. */
    values?: pulumi.Input<Record<string, unknown>>;
    after: pulumi.Resource[];
}

/** The agent on a Kubernetes cluster: its namespace, the Secret with its token, then its chart. */
export class ObservabilityAgent extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: ObservabilityAgentArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:ObservabilityAgent", name, {}, opts);
        const o = { parent: this, provider: args.cluster.provider, deletedWith: args.cluster.deletedWith };
        const ns = new k8s.core.v1.Namespace(`${name}/namespace`, { metadata: { name: args.chart.namespace } }, { ...o, dependsOn: args.after });
        const secret = new k8s.core.v1.Secret(`${name}/token`, {
            metadata: { name: AGENT_SECRET, namespace: ns.metadata.name },
            stringData: { STS_API_KEY: pulumi.secret(args.token) },
        }, o);
        this.release = helmApp(`${name}/chart`, {
            chart: args.chart.chart,
            ...(args.chart.repo ? { repo: args.chart.repo } : {}),
            version: args.chart.version,
            namespace: args.chart.namespace,
            values: args.values ?? {},
            lockedValues: agentValues(args.url, args.clusterName),
        }, { ...o, dependsOn: [secret] });
        this.registerOutputs({});
    }
}
