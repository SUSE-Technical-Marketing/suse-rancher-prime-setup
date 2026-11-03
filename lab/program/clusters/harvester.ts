import { HarvesterCloudConfig } from "@lab/harvester";
import { renderNetworkConfig, stableMac } from "@lab/os";
import { HarvesterCluster } from "@lab/rancher";
import { distribution, version } from "../catalog";
import type { ClusterBuilder, ClusterOf } from "./types";

// A cluster Rancher creates from VMs on a Harvester, with the Rancher's credential for it; a
// distribution that bundles the Harvester cloud provider (RKE2's `cloudProviders`) gets its config
// (a service account of its own on the Harvester).

export const harvester: ClusterBuilder<ClusterOf<"harvester">> = {
    build({ lab, rancher, harvesterCredential, base: baseOf, poolUserData }, d) {
        const base = baseOf(d.harvester);
        const credential = harvesterCredential(d.harvester);
        const dist = distribution(d.distro, lab);
        const cloudProviderConfig = dist.cloudProviders.includes("harvester") ? new HarvesterCloudConfig(`downstream/${d.name}/cloud-provider-config`, {
            harvester: d.harvester,
            namespace: base.namespace.metadata.name,
            serviceAccountName: d.name,
        }, { dependsOn: [base.namespace] }).kubeconfig : undefined;
        return new HarvesterCluster(`downstream/${d.name}`, {
            rancher,
            distribution: dist,
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
            pools: d.pools.map(pool => {
                // A one-machine pool with a fixed address: on the interface with its MAC, one of its own unless it has one.
                const macAddress = pool.macAddress ?? (pool.ip ? stableMac(lab.name, `${d.name}/${pool.name}`) : undefined);
                const { ip, ...rest } = pool;
                return {
                    ...rest,
                    image: base.images[lab.os[pool.os].image].id,
                    // `namespace/name`: a network already on the Harvester, not the lab's.
                    network: pool.network!.includes("/") ? pool.network! : base.networks[pool.network!],
                    ...(macAddress ? { macAddress, replaceFirst: true } : {}),
                    ...(ip ? { networkData: renderNetworkConfig({ macAddress: macAddress!, ...ip, search: [lab.domain] }) } : {}),
                    userData: poolUserData(pool.os, pool.roles, true),
                };
            }),
            after: [credential, base.namespace, ...base.ready],
        });
    },
};
