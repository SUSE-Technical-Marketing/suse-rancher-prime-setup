import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

interface Inputs {
    /** The Rancher cluster's kubeconfig (JSON). */
    rancherKubeconfig: string;
    /** The provisioning cluster's name in fleet-default. */
    cluster: string;
    /** Rancher's public URL, and whether its certificate is untrusted (Let's Encrypt staging). */
    rancherUrl: string;
    insecure: boolean;
}

/**
 * A kubeconfig for a cluster Rancher provisioned, talking to it through Rancher's proxy. The token
 * comes from the `<cluster>-kubeconfig` secret Rancher keeps in fleet-default; that kubeconfig itself
 * points at Rancher's in-cluster service address, so the server is Rancher's public URL instead.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const res = await kubeRequest({ kubeconfig: inputs.rancherKubeconfig }, "GET", `/api/v1/namespaces/fleet-default/secrets/${inputs.cluster}-kubeconfig`);
        const encoded = res.body?.data?.value;
        if (res.status !== 200 || !encoded) throw new Error(`reading the kubeconfig of ${inputs.cluster} from Rancher failed: HTTP ${res.status}`);
        const text = Buffer.from(encoded, "base64").toString("utf8");
        const token = /^\s*token:\s*"?([^"\s]+)"?\s*$/m.exec(text)?.[1];
        const path = /^\s*server:\s*"?https?:\/\/[^/\s"]+(\/k8s\/clusters\/[^"\s]+)"?\s*$/m.exec(text)?.[1];
        if (!token || !path) throw new Error(`the kubeconfig Rancher keeps for ${inputs.cluster} has no token or no /k8s/clusters/ server`);
        const kubeconfig = JSON.stringify({
            apiVersion: "v1",
            kind: "Config",
            clusters: [{ name: inputs.cluster, cluster: { server: `${inputs.rancherUrl.replace(/\/+$/, "")}${path}`, ...(inputs.insecure ? { "insecure-skip-tls-verify": true } : {}) } }],
            users: [{ name: inputs.cluster, user: { token } }],
            contexts: [{ name: inputs.cluster, context: { cluster: inputs.cluster, user: inputs.cluster } }],
            "current-context": inputs.cluster,
        });
        return { id: `fleet-default/${inputs.cluster}-kubeconfig`, outs: { ...inputs, kubeconfig } };
    },
    async diff(_id: string, olds: Inputs, news: Inputs) {
        const replaces = (["cluster", "rancherUrl", "insecure"] as const).filter(k => olds[k] !== news[k]);
        return { changes: replaces.length > 0, replaces };
    },
    async delete() {
        // Rancher's secret goes with the cluster.
    },
};

export class ClusterKubeconfig extends pulumi.dynamic.Resource {
    declare readonly kubeconfig: pulumi.Output<string>;

    constructor(name: string, args: { rancherKubeconfig: pulumi.Input<string>; cluster: string; rancherUrl: string; insecure: boolean }, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, rancherKubeconfig: pulumi.secret(args.rancherKubeconfig), kubeconfig: undefined }, { ...opts, additionalSecretOutputs: ["kubeconfig"] }, "lab", "ClusterKubeconfig");
    }
}
