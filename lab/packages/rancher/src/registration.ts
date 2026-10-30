import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

const NS = "fleet-default";
const CLUSTERS = `/apis/provisioning.cattle.io/v1/namespaces/${NS}/clusters`;
const TOKEN_PLACEHOLDER = "{token}";

interface RegistrationInputs {
    rancherKubeconfig: string;
    cluster: string;
    /** Rancher's certificate isn't trusted (Let's Encrypt staging): the node command fetches the installer without checking it. */
    insecure: boolean;
    /** Seconds to wait for the token. */
    timeoutSeconds: number;
}

/**
 * How to join a cluster Rancher knows but doesn't provision, from its registration token: the
 * command that registers a machine with a metal (Rancher: custom) cluster, and the manifest an imported cluster
 * applies (a k3k cluster). Newer Rancher keeps the token itself in a Secret next to it.
 */
const registrationProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: RegistrationInputs) {
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const rancher = { kubeconfig: inputs.rancherKubeconfig };
        const deadline = Date.now() + inputs.timeoutSeconds * 1000;
        while (Date.now() < deadline) {
            const clusterId = (await kubeRequest(rancher, "GET", `${CLUSTERS}/${inputs.cluster}`)).body?.status?.clusterName;
            const crt = clusterId ? (await kubeRequest(rancher, "GET", `/apis/management.cattle.io/v3/namespaces/${clusterId}/clusterregistrationtokens/default-token`)).body : undefined;
            const nodeCommand: string | undefined = inputs.insecure ? crt?.status?.insecureNodeCommand : crt?.status?.nodeCommand;
            const manifestUrl: string | undefined = crt?.status?.manifestUrl;
            if (nodeCommand && manifestUrl) {
                let token: string | undefined;
                if (nodeCommand.includes(TOKEN_PLACEHOLDER) || manifestUrl.includes(TOKEN_PLACEHOLDER)) {
                    const secretName = crt.status.tokenSecretName;
                    const encoded = secretName ? (await kubeRequest(rancher, "GET", `/api/v1/namespaces/${clusterId}/secrets/${secretName}`)).body?.data?.token : undefined;
                    token = encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() : undefined;
                }
                const fill = (s: string) => (s.includes(TOKEN_PLACEHOLDER) ? (token ? s.split(TOKEN_PLACEHOLDER).join(token) : undefined) : s);
                const outs = { nodeCommand: fill(nodeCommand), manifestUrl: fill(manifestUrl) };
                if (outs.nodeCommand && outs.manifestUrl) return { id: `${NS}/${inputs.cluster}/registration`, outs: { ...inputs, clusterId, ...outs } };
            }
            await sleep(5000);
        }
        throw new Error(`Rancher made no registration token for cluster ${inputs.cluster} within ${inputs.timeoutSeconds}s`);
    },
    async diff(_id: string, olds: RegistrationInputs, news: RegistrationInputs) {
        const replaces = (["cluster", "insecure"] as const).filter(k => olds[k] !== news[k]);
        return { changes: replaces.length > 0, replaces };
    },
    async delete() {
        // The token goes with the cluster.
    },
};

export class ClusterRegistration extends pulumi.dynamic.Resource {
    /** The management cluster id (`c-m-...`). */
    declare readonly clusterId: pulumi.Output<string>;
    declare readonly nodeCommand: pulumi.Output<string>;
    declare readonly manifestUrl: pulumi.Output<string>;

    constructor(name: string, args: { rancherKubeconfig: pulumi.Input<string>; cluster: string; insecure: boolean; timeoutSeconds: number }, opts?: pulumi.CustomResourceOptions) {
        super(registrationProvider, name, { ...args, rancherKubeconfig: pulumi.secret(args.rancherKubeconfig), clusterId: undefined, nodeCommand: undefined, manifestUrl: undefined },
            { ...opts, additionalSecretOutputs: ["nodeCommand", "manifestUrl"] }, "lab", "ClusterRegistration");
    }
}
