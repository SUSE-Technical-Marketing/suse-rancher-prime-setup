import * as pulumi from "@pulumi/pulumi";
import { kubeRequest, poll } from "@lab/kube";

// Waiting on and patching objects that something else creates (Rancher's settings, the `local`
// Fleet cluster, CRDs installed by a chart). Dynamic providers are serialized into the state, so
// they only use the self-contained kubeRequest.

interface WaitInputs {
    kubeconfig: string;
    path: string;
    /** Condition type that must be "True"; without one, the object only has to exist. */
    condition?: string;
    /** A Deployment whose rollout is complete (`rolloutProblem`). */
    rollout?: boolean;
    timeoutSeconds: number;
}

/**
 * What a Deployment's rollout still waits for, as `kubectl rollout status` judges it; undefined once
 * it's complete: its controller has seen its latest spec, and all its replicas are updated and
 * available, with none of the old ones left.
 */
export function rolloutProblem(d: { metadata?: { generation?: number }; spec?: { replicas?: number }; status?: Record<string, number | undefined> }): string | undefined {
    const s = d.status ?? {};
    const want = d.spec?.replicas ?? 1;
    if ((s.observedGeneration ?? 0) < (d.metadata?.generation ?? 0)) return "its latest spec isn't seen yet";
    if ((s.updatedReplicas ?? 0) < want) return `${s.updatedReplicas ?? 0} of ${want} replicas updated`;
    if ((s.replicas ?? 0) > (s.updatedReplicas ?? 0)) return `${(s.replicas ?? 0) - (s.updatedReplicas ?? 0)} old replicas still running`;
    if ((s.availableReplicas ?? 0) < (s.updatedReplicas ?? 0)) return `${s.availableReplicas ?? 0} of ${s.updatedReplicas} updated replicas available`;
    return undefined;
}

async function waitFor(inputs: WaitInputs): Promise<any> {
    return poll(async seen => {
        const res = await kubeRequest({ kubeconfig: inputs.kubeconfig }, "GET", inputs.path).catch(e => ({ status: 0, body: String(e) }));
        if (res.status !== 200) {
            seen(res.status === 404 ? "not found" : `HTTP ${res.status}`);
            return undefined;
        }
        if (inputs.rollout) {
            const problem = rolloutProblem(res.body ?? {});
            if (problem) {
                seen(`rollout: ${problem}`);
                return undefined;
            }
        }
        if (!inputs.condition) return res.body;
        const cond = (res.body?.status?.conditions ?? []).find((c: any) => c.type === inputs.condition);
        if (cond?.status === "True") return res.body;
        seen(cond ? `${inputs.condition}=${cond.status}${cond.message ? ` (${cond.message})` : ""}` : `no ${inputs.condition} condition yet`);
        return undefined;
    }, { timeoutSeconds: inputs.timeoutSeconds, failure: last => `timed out waiting for ${inputs.path}${inputs.condition ? ` to be ${inputs.condition}` : ""}${inputs.rollout ? " to roll out" : ""}: ${last}` });
}

const waitProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: WaitInputs) {
        await waitFor(inputs);
        return { id: inputs.path, outs: inputs };
    },
    async diff(_id: string, olds: WaitInputs, news: WaitInputs) {
        const changes = olds.path !== news.path || olds.condition !== news.condition || !!olds.rollout !== !!news.rollout;
        return { changes, replaces: changes ? ["path"] : [] };
    },
    async delete() {
        // Only waits; nothing to remove.
    },
};

export interface KubeWaitArgs {
    /** The cluster's kubeconfig (JSON); kept secret. */
    kubeconfig: pulumi.Input<string>;
    /** API path, e.g. `/apis/fleet.cattle.io/v1alpha1/namespaces/fleet-local/clusters/local`. */
    path: pulumi.Input<string>;
    condition?: string;
    /** A Deployment at `path`: wait until its rollout is complete, as `kubectl rollout status`. */
    rollout?: boolean;
    timeoutSeconds: number;
}

/** Wait until an object exists (and has a condition that is True). */
export class KubeWait extends pulumi.dynamic.Resource {
    constructor(name: string, args: KubeWaitArgs, opts?: pulumi.CustomResourceOptions) {
        super(waitProvider, name, { ...args, kubeconfig: pulumi.secret(args.kubeconfig), timeoutSeconds: args.timeoutSeconds }, opts, "lab", "KubeWait");
    }
}

interface PatchInputs {
    kubeconfig: string;
    path: string;
    patch: Record<string, unknown>;
    /** How long to wait for the object to exist. */
    timeoutSeconds: number;
}

const patchProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: PatchInputs) {
        await waitFor({ kubeconfig: inputs.kubeconfig, path: inputs.path, timeoutSeconds: inputs.timeoutSeconds });
        const res = await kubeRequest({ kubeconfig: inputs.kubeconfig }, "PATCH", inputs.path, inputs.patch);
        if (res.status !== 200) throw new Error(`patching ${inputs.path} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        return { id: inputs.path, outs: inputs };
    },
    async diff(_id: string, olds: PatchInputs, news: PatchInputs) {
        return { changes: olds.path !== news.path || JSON.stringify(olds.patch) !== JSON.stringify(news.patch), replaces: olds.path !== news.path ? ["path"] : [] };
    },
    async update(_id: string, _olds: PatchInputs, news: PatchInputs) {
        const res = await kubeRequest({ kubeconfig: news.kubeconfig }, "PATCH", news.path, news.patch);
        if (res.status !== 200) throw new Error(`patching ${news.path} failed: HTTP ${res.status}`);
        return { outs: news };
    },
    async delete() {
        // The object belongs to whoever created it (Rancher); the patch stays until the lab goes.
    },
};

export interface KubePatchArgs {
    kubeconfig: pulumi.Input<string>;
    path: string;
    /** JSON merge patch. */
    patch: pulumi.Input<Record<string, unknown>>;
    /** How long to wait for the object to exist. */
    timeoutSeconds: number;
}

/** Merge-patch an object someone else owns, once it exists. */
export class KubePatch extends pulumi.dynamic.Resource {
    constructor(name: string, args: KubePatchArgs, opts?: pulumi.CustomResourceOptions) {
        super(patchProvider, name, { ...args, kubeconfig: pulumi.secret(args.kubeconfig) }, opts, "lab", "KubePatch");
    }
}

interface AdmitInputs {
    kubeconfig: string;
    /** The collection to create in, e.g. `/apis/metallb.io/v1beta1/namespaces/metallb-system/ipaddresspools`. */
    path: string;
    object: Record<string, unknown>;
    timeoutSeconds: number;
}

const admitProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: AdmitInputs) {
        await poll(async seen => {
            const res = await kubeRequest({ kubeconfig: inputs.kubeconfig }, "POST", `${inputs.path}?dryRun=All`, inputs.object).catch(e => ({ status: 0, body: String(e) }));
            // Answered: accepted, or rejected by the webhook itself (a real problem, reported by the create).
            if (res.status < 500 && res.status !== 0 && res.status !== 404) return true;
            seen(`HTTP ${res.status} ${typeof res.body === "object" ? res.body?.message ?? "" : String(res.body)}`.slice(0, 300));
            return undefined;
        }, { timeoutSeconds: inputs.timeoutSeconds, failure: last => `timed out waiting for the API server to admit an object in ${inputs.path}: ${last}` });
        return { id: inputs.path, outs: inputs };
    },
    async diff(_id: string, olds: AdmitInputs, news: AdmitInputs) {
        const changes = olds.path !== news.path;
        return { changes, replaces: changes ? ["path"] : [] };
    },
    async delete() {
        // Only waits; nothing to remove.
    },
};

export interface KubeAdmittedArgs {
    kubeconfig: pulumi.Input<string>;
    path: string;
    object: Record<string, unknown>;
    timeoutSeconds: number;
}

/**
 * Wait until the API server can admit an object: a dry-run create until its admission webhooks
 * answer. A chart's webhook pod can be Ready before the API server reaches it (RKE2 dials pods
 * through its agent tunnel), and the first real create would fail.
 */
export class KubeAdmitted extends pulumi.dynamic.Resource {
    constructor(name: string, args: KubeAdmittedArgs, opts?: pulumi.CustomResourceOptions) {
        super(admitProvider, name, { ...args, kubeconfig: pulumi.secret(args.kubeconfig), timeoutSeconds: args.timeoutSeconds }, opts, "lab", "KubeAdmitted");
    }
}
