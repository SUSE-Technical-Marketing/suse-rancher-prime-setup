import { MetalCluster } from "@lab/rancher";
import { distribution, version } from "../catalog";
import type { ClusterBuilder, ClusterOf } from "./types";

// Rancher installs Kubernetes on the lab's own hosts: each node registers over SSH once it's set up.

export const metal: ClusterBuilder<ClusterOf<"metal">> = {
    build({ lab, rancher, node, machineCommands }, d) {
        return new MetalCluster(`downstream/${d.name}`, {
            rancher,
            distribution: distribution(d.distro, lab),
            kubernetesVersion: d.version ?? version(d.distro, lab),
            labels: d.labels,
            annotations: d.annotations,
            cni: d.cni,
            machineGlobalConfig: d.machineGlobalConfig,
            chartValues: d.chartValues,
            timeouts: lab.timeouts,
            nodes: d.nodes.map(n => {
                const { host, access, ready, machine } = node(n.host);
                return {
                    host: access,
                    roles: n.roles,
                    // A lab VM got its OS profile's setup from its user data; a machine gets it now.
                    prepare: host.kind === "ssh" ? machineCommands(lab.os[host.os], true) : [],
                    after: ready,
                    deletedWith: machine,
                };
            }),
        });
    },
};
