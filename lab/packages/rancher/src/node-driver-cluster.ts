import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { provisioning } from "@lab/crds";
import { deepMerge } from "@lab/kubernetes";
import type { ResolvedDistribution, Timeouts } from "@lab/schema";
import { ClusterKubeconfig, managementClusterId } from "./cluster-kubeconfig";
import { RancherAccess } from "./server";

/** A machine pool, whatever creates its machines. */
export interface NodePool {
    name: string;
    quantity: number;
    roles: ("etcd" | "controlplane" | "worker")[];
}

/** What every cluster Rancher creates machines for takes. */
export interface NodeDriverClusterArgs {
    rancher: RancherAccess;
    /** Its KubernetesDistribution document: the default CNI and the data directory. */
    distribution: ResolvedDistribution;
    kubernetesVersion: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** `cattle-global-data:cc-xxxxx` of the cloud credential the node driver uses. */
    cloudCredential: pulumi.Input<string>;
    /** CNI; default the distribution's `cni`. */
    cni?: string;
    /** The lab's own `machineGlobalConfig` and `chartValues`, merged over the engine's. */
    machineGlobalConfig?: Record<string, unknown>;
    chartValues?: Record<string, unknown>;
    /** What has to exist first and outlive the cluster: where the machines go, the credential. */
    after?: pulumi.Resource[];
    timeouts: Pick<Timeouts, "downstreamReady" | "downstreamDelete">;
}

/** What a node driver adds to the cluster: a machine config per pool, and its own settings. */
export interface MachineDriver {
    /** The machine configs' kind (`HarvesterConfig`), as the pools refer to them. */
    kind: string;
    /** One per pool, in the pools' order. */
    machineConfigs: (pulumi.CustomResource & { metadata: pulumi.Output<{ name: string }> })[];
    machineSelectorConfig?: Record<string, pulumi.Input<string>>;
    /** Values for the distribution's bundled charts, under the lab's own. */
    chartValues?: Record<string, unknown>;
    /** Further resources the Cluster waits for. */
    dependsOn?: pulumi.Resource[];
}

export const NS = "fleet-default";

/**
 * The `provisioning.cattle.io` Cluster of a cluster Rancher creates machines for, waited on until
 * Ready, and a provider for it. `driver` makes the machine configs, with the options every
 * resource of the cluster takes. Its labels reach the Fleet cluster, so `fleet.groups` selectors
 * match them.
 *
 * Unlike everything else on the Rancher VM these are deleted one by one, before Rancher goes:
 * deleting the Cluster makes Rancher remove its machines.
 */
export function nodeDriverCluster(
    self: pulumi.ComponentResource,
    name: string,
    args: NodeDriverClusterArgs,
    pools: NodePool[],
    driver: (o: pulumi.CustomResourceOptions, clusterName: string) => MachineDriver,
): { cluster: provisioning.v1.Cluster; provider: k8s.Provider; clusterId: pulumi.Output<string> } {
    const o: pulumi.CustomResourceOptions = { parent: self, provider: args.rancher.provider, dependsOn: [...args.rancher.ready, ...(args.after ?? [])] };
    const clusterName = name.split("/").pop()!;
    const machines = driver(o, clusterName);

    const cluster = new provisioning.v1.Cluster(`${name}/cluster`, {
        metadata: {
            name: clusterName,
            namespace: NS,
            // Not an empty map: Kubernetes drops it, and every preview would show it again.
            ...(Object.keys(args.labels).length > 0 ? { labels: args.labels } : {}),
            annotations: { ...args.annotations, "pulumi.com/waitFor": "condition=Ready", "pulumi.com/timeoutSeconds": String(args.timeouts.downstreamReady) },
        },
        spec: {
            kubernetesVersion: args.kubernetesVersion,
            cloudCredentialSecretName: args.cloudCredential,
            rkeConfig: {
                machineGlobalConfig: deepMerge(args.machineGlobalConfig ?? {}, { cni: args.cni ?? args.distribution.cni }),
                machineSelectorConfig: [{ config: machines.machineSelectorConfig ?? {} }],
                chartValues: deepMerge(args.chartValues ?? {}, machines.chartValues ?? {}),
                machinePools: pools.map((pool, i) => ({
                    name: pool.name,
                    quantity: pool.quantity,
                    etcdRole: pool.roles.includes("etcd"),
                    controlPlaneRole: pool.roles.includes("controlplane"),
                    workerRole: pool.roles.includes("worker"),
                    machineConfigRef: { kind: machines.kind, name: machines.machineConfigs[i].metadata.name },
                })),
            },
        },
    }, {
        ...o,
        dependsOn: [...(o.dependsOn as pulumi.Resource[]), ...machines.machineConfigs, ...(machines.dependsOn ?? [])],
        // Rancher deletes the machines before the Cluster object goes.
        customTimeouts: { create: `${args.timeouts.downstreamReady}s`, delete: `${args.timeouts.downstreamDelete}s` },
    });

    const kubeconfig = new ClusterKubeconfig(`${name}/kubeconfig`, {
        rancherKubeconfig: args.rancher.cluster.kubeconfig,
        cluster: clusterName,
        rancherUrl: args.rancher.url,
        insecure: args.rancher.insecure,
    }, { parent: self, dependsOn: [cluster], deletedWith: cluster });
    const provider = new k8s.Provider(`${name}/provider`, { kubeconfig: kubeconfig.kubeconfig, suppressHelmHookWarnings: true }, { parent: self });
    return { cluster, provider, clusterId: managementClusterId(kubeconfig.kubeconfig) };
}

const UNITS: Record<string, number> = { Mi: 1 / 1024, Gi: 1, Ti: 1024 };

/** Node drivers take sizes in whole GiB. */
export function toGiB(quantity: string): number {
    const m = /^(\d+)(Mi|Gi|Ti)$/.exec(quantity);
    if (!m) throw new Error(`size ${quantity}: use Mi, Gi or Ti`);
    return Math.ceil(Number(m[1]) * UNITS[m[2]]);
}
