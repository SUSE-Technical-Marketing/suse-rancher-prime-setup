import type * as pulumi from "@pulumi/pulumi";
import { helmApp } from "@lab/kubernetes";
import { K3kCluster } from "@lab/rancher";
import { chartInNamespace } from "../catalog";
import type { BuiltCluster, ClusterBuilder, ClusterOf } from "./types";

// A k3k virtual cluster in another downstream cluster, once that one exists. The k3k operator goes on
// each parent once, however many k3k clusters run in it.

const operators = new WeakMap<BuiltCluster, pulumi.Resource>();

export const k3k: ClusterBuilder<ClusterOf<"k3k">> = {
    nested: true,
    build({ lab, rancher, built }, d) {
        const parent = built[d.parent];
        let operator = operators.get(parent);
        if (!operator) {
            operator = helmApp(`downstream/${d.parent}/k3k-operator`, chartInNamespace("k3k", lab), {
                provider: parent.provider, dependsOn: [parent.cluster], deletedWith: parent.cluster,
            });
            operators.set(parent, operator);
        }
        return new K3kCluster(`downstream/${d.name}`, {
            rancher,
            parent: { name: d.parent, provider: parent.provider, clusterId: parent.clusterId, cluster: parent.cluster, operator },
            namespace: d.namespace!,
            mode: d.mode,
            servers: d.servers,
            agents: d.agents,
            version: d.version,
            persistence: d.persistence,
            labels: d.labels,
            annotations: d.annotations,
            kubectlImage: lab.images.kubectl,
            timeouts: lab.timeouts,
        });
    },
};
