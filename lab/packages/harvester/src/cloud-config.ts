import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

interface Inputs {
    harvester: string;
    namespace: string;
    serviceAccountName: string;
}

/**
 * A kubeconfig for the Harvester cloud provider in a guest cluster: a service account in the lab's
 * namespace with Harvester's `harvesterhci.io:cloudprovider` role, made by Harvester's own API.
 * The service account lives in the lab namespace and goes with it.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const res = await kubeRequest({ context: inputs.harvester, harvesterApi: true }, "POST", "/v1/harvester/kubeconfig", {
            clusterRoleName: "harvesterhci.io:cloudprovider",
            namespace: inputs.namespace,
            serviceAccountName: inputs.serviceAccountName,
        });
        if (res.status !== 200) throw new Error(`generating the cloud-provider kubeconfig on ${inputs.harvester} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
        const kubeconfig = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
        return { id: `${inputs.harvester}/${inputs.namespace}/${inputs.serviceAccountName}`, outs: { ...inputs, kubeconfig } };
    },
    async diff(_id: string, olds: Inputs, news: Inputs) {
        const changes = (["harvester", "namespace", "serviceAccountName"] as const).some(k => olds[k] !== news[k]);
        return { changes, replaces: changes ? ["serviceAccountName"] : [], deleteBeforeReplace: true };
    },
    async delete(_id: string, props: Inputs) {
        const ns = `/api/v1/namespaces/${props.namespace}`;
        await kubeRequest({ context: props.harvester }, "DELETE", `/apis/rbac.authorization.k8s.io/v1/namespaces/${props.namespace}/rolebindings/${props.serviceAccountName}`).catch(() => undefined);
        await kubeRequest({ context: props.harvester }, "DELETE", `${ns}/serviceaccounts/${props.serviceAccountName}`).catch(() => undefined);
    },
};

export interface HarvesterCloudConfigArgs {
    harvester: string;
    namespace: pulumi.Input<string>;
    serviceAccountName: string;
}

export class HarvesterCloudConfig extends pulumi.dynamic.Resource {
    declare readonly kubeconfig: pulumi.Output<string>;

    constructor(name: string, args: HarvesterCloudConfigArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, kubeconfig: undefined }, { ...opts, additionalSecretOutputs: ["kubeconfig"] }, "lab", "HarvesterCloudConfig");
    }
}
