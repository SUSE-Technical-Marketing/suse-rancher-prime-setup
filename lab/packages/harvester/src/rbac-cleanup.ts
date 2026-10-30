import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

interface Inputs {
    harvester: string;
    namespace: string;
}

const CRBS = "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings";

/**
 * Removes the cluster role bindings of the service accounts in the lab's namespace. Harvester
 * makes them when it hands out a kubeconfig (the cloud provider's, Rancher's node driver's), and
 * deleting the namespace removes the service accounts but not the cluster-wide bindings.
 *
 * Nothing happens on create. The namespace depends on this resource, so on destroy it runs after
 * the namespace is gone. Only bindings whose subjects are all service accounts in the namespace
 * are removed: nothing else can be the lab's.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        return { id: `${inputs.harvester}/${inputs.namespace}/clusterrolebindings`, outs: inputs };
    },
    async delete(_id: string, props: Inputs) {
        const target = { context: props.harvester };
        const list = await kubeRequest(target, "GET", CRBS);
        if (list.status !== 200) throw new Error(`listing cluster role bindings on ${props.harvester} failed: HTTP ${list.status}`);
        for (const b of list.body?.items ?? []) {
            const subjects: any[] = b.subjects ?? [];
            if (subjects.length === 0 || !subjects.every(s => s.kind === "ServiceAccount" && s.namespace === props.namespace)) continue;
            const res = await kubeRequest(target, "DELETE", `${CRBS}/${b.metadata.name}`);
            if (res.status !== 200 && res.status !== 404) throw new Error(`deleting cluster role binding ${b.metadata.name} on ${props.harvester} failed: HTTP ${res.status}`);
        }
    },
};

export class NamespaceBindingsCleanup extends pulumi.dynamic.Resource {
    constructor(name: string, args: { harvester: string; namespace: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, args, opts, "lab", "NamespaceBindingsCleanup");
    }
}
