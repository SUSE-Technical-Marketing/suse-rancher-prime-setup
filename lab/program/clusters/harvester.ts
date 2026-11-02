import { HarvesterCloudConfig } from "@lab/harvester";
import { HarvesterCluster } from "@lab/rancher";
import { distribution, version } from "../catalog";
import type { ClusterBuilder, ClusterOf } from "./types";

// A cluster Rancher creates from VMs on a Harvester, with the Rancher's credential for it; RKE2 gets
// the Harvester cloud provider's config (a service account of its own on the Harvester).

export const harvester: ClusterBuilder<ClusterOf<"harvester">> = {
    build({ lab, rancher, harvesterCredential, base: baseOf, poolUserData }, d) {
        const base = baseOf(d.harvester);
        const credential = harvesterCredential(d.harvester);
        const cloudProviderConfig = d.distro === "rke2" ? new HarvesterCloudConfig(`downstream/${d.name}/cloud-provider-config`, {
            harvester: d.harvester,
            namespace: base.namespace.metadata.name,
            serviceAccountName: d.name,
        }, { dependsOn: [base.namespace] }).kubeconfig : undefined;
        return new HarvesterCluster(`downstream/${d.name}`, {
            rancher,
            distro: d.distro,
            distribution: distribution(d.distro, lab),
            kubernetesVersion: d.version ?? version(d.distro, lab),
            labels: d.labels,
            annotations: d.annotations,
            cloudCredential: credential.secretName,
            vmNamespace: base.namespace.metadata.name,
            sshUser: lab.ssh!.user,
            cloudProviderConfig,
            cni: d.cni,
            machineGlobalConfig: d.machineGlobalConfig,
            chartValues: d.chartValues,
            timeouts: lab.timeouts,
            pools: d.pools.map(pool => ({
                ...pool,
                image: base.images[lab.os[pool.os].image].id,
                network: base.networks[pool.network!],
                userData: poolUserData(pool.os, pool.roles, true),
            })),
            after: [credential, base.namespace, ...base.ready],
        });
    },
};
