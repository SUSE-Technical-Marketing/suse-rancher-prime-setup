import * as pulumi from "@pulumi/pulumi";
import { KubeTarget, kubeRequest } from "@lab/kube";

/**
 * Waits for a field on a Kubernetes object to get a value, and returns it. Used for things
 * Harvester fills in asynchronously, like a VM's IP address in its VirtualMachineInstance.
 *
 * Credentials never enter the state: see kubeRequest.
 */
export interface KubeValueArgs {
    /** A Harvester's kubeconfig context (its name), or a lab cluster's kubeconfig (JSON, secret). */
    target: pulumi.Input<{ context: string } | { kubeconfig: pulumi.Input<string> }>;
    /** API path of the object, e.g. `/apis/kubevirt.io/v1/namespaces/lab/virtualmachineinstances/vm`. */
    path: pulumi.Input<string>;
    /** Dot path of the field, numbers index arrays: `status.interfaces.0.ipAddress`. */
    field: pulumi.Input<string>;
    timeoutSeconds?: pulumi.Input<number>;
}

interface Inputs {
    target: KubeTarget;
    path: string;
    field: string;
    timeoutSeconds?: number;
}

// Dynamic providers are serialized into the state; kubeRequest is self-contained for that reason.
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const deadline = Date.now() + (inputs.timeoutSeconds ?? 600) * 1000;
        while (Date.now() < deadline) {
            const res = await kubeRequest(inputs.target, "GET", inputs.path).catch(() => undefined);
            const obj = res?.status === 200 ? res.body : undefined;
            const value = inputs.field.split(".").reduce((v: any, key) => (v == null ? undefined : v[key]), obj);
            if (value !== undefined && value !== null && value !== "") {
                return { id: `${inputs.path}#${inputs.field}`, outs: { ...inputs, value: String(value) } };
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error(`timed out waiting for ${inputs.field} on ${inputs.path}`);
    },

    async diff(_id: string, olds: Inputs, news: Inputs) {
        const replaces = (["target", "path", "field"] as const).filter(k => JSON.stringify(olds[k]) !== JSON.stringify(news[k]));
        return { changes: replaces.length > 0, replaces };
    },

    async delete() {
        // Nothing to clean up: this only reads.
    },
};

export class KubeValue extends pulumi.dynamic.Resource {
    declare readonly value: pulumi.Output<string>;

    constructor(name: string, args: KubeValueArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { value: undefined, ...args }, opts, "lab", "KubeValue");
    }
}
