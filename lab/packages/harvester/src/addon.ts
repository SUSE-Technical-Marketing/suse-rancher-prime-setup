import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

export interface HarvesterAddonArgs {
    /** The Harvester's name, which is also its kubeconfig context. */
    harvester: string;
    name: string;
    namespace: string;
    repo: string;
    chart: string;
    version: pulumi.Input<string>;
    valuesContent?: pulumi.Input<string>;
    labels?: Record<string, string>;
    /** How long to wait for it to deploy, or be removed. */
    timeoutSeconds: number;
    /**
     * Use an add-on of this chart that's already there (installed by hand, or by another setup)
     * instead of failing: it's waited for, never changed or removed. The DHCP controller: one per
     * Harvester, whoever installed it.
     */
    shared?: boolean;
}

interface Inputs {
    harvester: string;
    name: string;
    namespace: string;
    repo: string;
    chart: string;
    version: string;
    valuesContent?: string;
    labels?: Record<string, string>;
    timeoutSeconds?: number;
    shared?: boolean;
}

/** What's stored: the inputs, and whether the add-on was there already (then it isn't the lab's). */
interface Outputs extends Inputs {
    adopted?: boolean;
}

/**
 * A Harvester add-on, removed the way Harvester expects: disable it, wait until its HelmChart is
 * gone (the uninstall ran), then delete it. Deleting an enabled Add-on object directly makes the
 * uninstall job lose its service account to garbage collection, leaving the chart installed.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const base = `/apis/harvesterhci.io/v1beta1/namespaces/${inputs.namespace}/addons`;
        const res = await kubeRequest({ context: inputs.harvester }, "POST", base, {
            apiVersion: "harvesterhci.io/v1beta1",
            kind: "Addon",
            metadata: { name: inputs.name, namespace: inputs.namespace, labels: inputs.labels ?? {} },
            spec: { enabled: true, repo: inputs.repo, chart: inputs.chart, version: inputs.version, valuesContent: inputs.valuesContent ?? "" },
        });
        if (res.status === 409) {
            const existing = (await kubeRequest({ context: inputs.harvester }, "GET", `${base}/${inputs.name}`)).body;
            if (inputs.shared && existing?.spec?.chart === inputs.chart && existing?.spec?.enabled) {
                // Someone else's: the lab uses it as it is, once it's deployed.
                await waitCompleted(inputs);
                return { id: `${inputs.harvester}/${inputs.namespace}/${inputs.name}`, outs: { ...inputs, adopted: true } };
            }
            throw new Error(`add-on ${inputs.namespace}/${inputs.name} already exists on ${inputs.harvester}${inputs.shared ? ` with ${existing?.spec?.enabled ? `chart ${existing?.spec?.chart}` : "it disabled"}` : ""}; is another lab or a manual install using it?`);
        }
        if (res.status !== 201 && res.status !== 200) throw new Error(`creating add-on ${inputs.name} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        await waitCompleted(inputs);
        return { id: `${inputs.harvester}/${inputs.namespace}/${inputs.name}`, outs: inputs };
    },

    async diff(_id: string, olds: Outputs, news: Inputs) {
        const replaces = (["harvester", "name", "namespace"] as const).filter(k => olds[k] !== news[k]);
        const { adopted, ...was } = olds;
        const changes = replaces.length > 0 || JSON.stringify(was) !== JSON.stringify(news);
        return { changes, replaces, deleteBeforeReplace: true };
    },

    async update(_id: string, olds: Outputs, news: Inputs) {
        // Someone else's add-on isn't the lab's to change.
        if (olds.adopted) return { outs: { ...news, adopted: true } };
        const res = await kubeRequest({ context: news.harvester }, "PATCH", `/apis/harvesterhci.io/v1beta1/namespaces/${news.namespace}/addons/${news.name}`, {
            metadata: { labels: news.labels ?? {} },
            spec: { enabled: true, repo: news.repo, chart: news.chart, version: news.version, valuesContent: news.valuesContent ?? "" },
        });
        if (res.status !== 200) throw new Error(`updating add-on ${news.name} failed: HTTP ${res.status}`);
        await waitCompleted(news);
        return { outs: news };
    },

    async delete(_id: string, props: Outputs) {
        // Nor to remove.
        if (props.adopted) return;
        const addon = `/apis/harvesterhci.io/v1beta1/namespaces/${props.namespace}/addons/${props.name}`;
        const chart = `/apis/helm.cattle.io/v1/namespaces/${props.namespace}/helmcharts/${props.name}`;
        const disabled = await kubeRequest({ context: props.harvester }, "PATCH", addon, { spec: { enabled: false } });
        if (disabled.status === 404) return;
        if (disabled.status !== 200) throw new Error(`disabling add-on ${props.name} failed: HTTP ${disabled.status}`);
        await poll(`add-on ${props.name} to uninstall`, props, async () => (await kubeRequest({ context: props.harvester }, "GET", chart)).status === 404);
        const deleted = await kubeRequest({ context: props.harvester }, "DELETE", addon);
        if (deleted.status !== 200 && deleted.status !== 202 && deleted.status !== 404) throw new Error(`deleting add-on ${props.name} failed: HTTP ${deleted.status}`);
        await poll(`add-on ${props.name} to be deleted`, props, async () => (await kubeRequest({ context: props.harvester }, "GET", addon)).status === 404);
    },
};

async function waitCompleted(inputs: Inputs): Promise<void> {
    const path = `/apis/harvesterhci.io/v1beta1/namespaces/${inputs.namespace}/addons/${inputs.name}`;
    await poll(`add-on ${inputs.name} to deploy`, inputs, async () => {
        const res = await kubeRequest({ context: inputs.harvester }, "GET", path);
        const conditions: any[] = res.body?.status?.conditions ?? [];
        return conditions.some(c => c.type === "Completed" && c.status === "True");
    });
}

async function poll(what: string, inputs: Inputs, done: () => Promise<boolean>): Promise<void> {
    // Add-ons created before the timeout was an input waited 15 minutes.
    const deadline = Date.now() + (inputs.timeoutSeconds ?? 900) * 1000;
    while (Date.now() < deadline) {
        if (await done().catch(() => false)) return;
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`timed out waiting for ${what}`);
}

export class HarvesterAddon extends pulumi.dynamic.Resource {
    constructor(name: string, args: HarvesterAddonArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, args, opts, "lab", "HarvesterAddon");
    }
}
