import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

interface Inputs {
    harvester: string;
    namespace: string;
}

const LBS = (ns: string) => `/apis/loadbalancer.harvesterhci.io/v1beta1/namespaces/${ns}/loadbalancers`;

/**
 * Removes the Harvester load balancers that guest-cluster cloud providers created in the lab's
 * namespace. They're normally removed when the guest's Service is deleted, but a lab deletes its
 * VMs whole (`deletedWith`), so they'd stay behind, keep their IPs, and block deleting the pool.
 *
 * Nothing happens on create. VMs depend on this resource and it depends on the pools, so on
 * destroy it runs after the VMs are gone and before the pools are deleted.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        return { id: `${inputs.harvester}/${inputs.namespace}/loadbalancers`, outs: inputs };
    },
    async delete(_id: string, props: Inputs) {
        const target = { context: props.harvester };
        const list = await kubeRequest(target, "GET", LBS(props.namespace));
        if (list.status === 404) return;
        for (const lb of list.body?.items ?? []) {
            await kubeRequest(target, "DELETE", `${LBS(props.namespace)}/${lb.metadata.name}`);
        }
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
            const left = await kubeRequest(target, "GET", LBS(props.namespace));
            if (left.status === 404 || (left.body?.items ?? []).length === 0) return;
            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error(`load balancers in ${props.namespace} on ${props.harvester} weren't removed within 5 minutes`);
    },
};

export class LoadBalancerCleanup extends pulumi.dynamic.Resource {
    constructor(name: string, args: { harvester: string; namespace: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, args, opts, "lab", "LoadBalancerCleanup");
    }
}
