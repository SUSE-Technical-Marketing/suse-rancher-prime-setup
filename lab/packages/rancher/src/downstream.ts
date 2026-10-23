import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { provisioning, rke_machine_config } from "@lab/crds";
import { deepMerge } from "@lab/kubernetes";
import type { ResolvedDistribution } from "@lab/schema";
import { ClusterKubeconfig } from "./cluster-kubeconfig";
import { RancherAccess } from "./server";

export interface HarvesterMachinePool {
    name: string;
    quantity: number;
    roles: ("etcd" | "controlplane" | "worker")[];
    cpu: number;
    memory: string;
    disk: string;
    /** Image on the Harvester, `namespace/name`. */
    image: pulumi.Input<string>;
    /** VM network, `namespace/name`. */
    network: pulumi.Input<string>;
    userData: pulumi.Input<string>;
}

export interface HarvesterClusterArgs {
    rancher: RancherAccess;
    distro: "rke2" | "k3s";
    /** Its KubernetesDistribution document: the default CNI and the data directory. */
    distribution: ResolvedDistribution;
    kubernetesVersion: string;
    labels: Record<string, string>;
    /** `cattle-global-data:cc-xxxxx` of the Harvester's cloud credential. */
    cloudCredential: pulumi.Input<string>;
    /** Namespace on the Harvester the VMs go in. */
    vmNamespace: pulumi.Input<string>;
    /** Login rancher-machine uses on the VMs; the pools' user data has to create it. */
    sshUser: string;
    /** Kubeconfig for the Harvester cloud provider in the new cluster (RKE2 only). */
    cloudProviderConfig?: pulumi.Input<string>;
    pools: HarvesterMachinePool[];
    /** CNI; default the distribution's `cni`. */
    cni?: string;
    /** The lab's own `machineGlobalConfig` and `chartValues`, merged over the engine's. */
    machineGlobalConfig?: Record<string, unknown>;
    chartValues?: Record<string, unknown>;
    /** What has to exist first and outlive the cluster: the Harvester's networks and images, the credential. */
    after?: pulumi.Resource[];
}

const NS = "fleet-default";
const UNITS: Record<string, number> = { Mi: 1 / 1024, Gi: 1, Ti: 1024 };

/** Harvester's node driver takes sizes in whole GiB. */
export function toGiB(quantity: string): number {
    const m = /^(\d+)(Mi|Gi|Ti)$/.exec(quantity);
    if (!m) throw new Error(`size ${quantity}: use Mi, Gi or Ti`);
    return Math.ceil(Number(m[1]) * UNITS[m[2]]);
}

/**
 * A cluster Rancher provisions on an imported Harvester: one `HarvesterConfig` per machine pool
 * and the `provisioning.cattle.io` Cluster, waited on until Ready. Its labels reach the Fleet
 * cluster, so `fleet.groups` selectors match them.
 *
 * Unlike everything else on the Rancher VM these are deleted one by one, before Rancher goes:
 * deleting the Cluster makes Rancher remove its machines, and so the VMs on the Harvester.
 */
export class HarvesterCluster extends pulumi.ComponentResource {
    readonly cluster: provisioning.v1.Cluster;
    /** A provider for the new cluster (through Rancher); resources on it are deleted with the cluster. */
    readonly provider: k8s.Provider;

    constructor(name: string, args: HarvesterClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:HarvesterCluster", name, {}, opts);
        const o: pulumi.CustomResourceOptions = { parent: this, provider: args.rancher.provider, dependsOn: [...args.rancher.ready, ...(args.after ?? [])] };
        const clusterName = name.split("/").pop()!;

        // Rancher hands a secret to a cluster only when the secret names it.
        const cloudConfig = args.distro === "rke2" && args.cloudProviderConfig ? new k8s.core.v1.Secret(`${name}/cloud-provider-config`, {
            metadata: {
                name: `${clusterName}-cloud-provider-config`,
                namespace: NS,
                annotations: { "v2prov-secret-authorized-for-cluster": clusterName },
            },
            stringData: { credential: args.cloudProviderConfig },
        }, o) : undefined;

        const machineConfigs = args.pools.map(pool => new rke_machine_config.v1.HarvesterConfig(`${name}/${pool.name}`, {
            metadata: { name: `${clusterName}-${pool.name}`, namespace: NS },
            cpuCount: String(pool.cpu),
            memorySize: String(toGiB(pool.memory)),
            diskInfo: pulumi.output(pool.image).apply(imageName => JSON.stringify({ disks: [{ imageName, size: toGiB(pool.disk), bootOrder: 1 }] })),
            networkInfo: pulumi.output(pool.network).apply(networkName => JSON.stringify({ interfaces: [{ networkName }] })),
            sshUser: args.sshUser,
            userData: pool.userData,
            networkData: "",
            vmNamespace: args.vmNamespace,
        }, o));

        this.cluster = new provisioning.v1.Cluster(`${name}/cluster`, {
            metadata: {
                name: clusterName,
                namespace: NS,
                labels: args.labels,
                annotations: { "pulumi.com/waitFor": "condition=Ready", "pulumi.com/timeoutSeconds": "3600" },
            },
            spec: {
                kubernetesVersion: args.kubernetesVersion,
                cloudCredentialSecretName: args.cloudCredential,
                rkeConfig: {
                    machineGlobalConfig: deepMerge(args.machineGlobalConfig ?? {}, { cni: args.cni ?? args.distribution.cni }),
                    machineSelectorConfig: [{
                        config: cloudConfig
                            ? { "cloud-provider-name": "harvester", "cloud-provider-config": pulumi.interpolate`secret://${NS}:${cloudConfig.metadata.name}` }
                            : {},
                    }],
                    chartValues: deepMerge(args.chartValues ?? {}, cloudConfig ? {
                        "harvester-cloud-provider": {
                            clusterName,
                            cloudConfigPath: `${args.distribution.dataDir}/etc/config-files/cloud-provider-config`,
                        },
                    } : {}),
                    machinePools: args.pools.map((pool, i) => ({
                        name: pool.name,
                        quantity: pool.quantity,
                        etcdRole: pool.roles.includes("etcd"),
                        controlPlaneRole: pool.roles.includes("controlplane"),
                        workerRole: pool.roles.includes("worker"),
                        machineConfigRef: { kind: "HarvesterConfig", name: machineConfigs[i].metadata.name },
                    })),
                },
            },
        }, {
            ...o,
            dependsOn: [...(o.dependsOn as pulumi.Resource[]), ...machineConfigs, ...(cloudConfig ? [cloudConfig] : [])],
            // Rancher deletes the machines (VMs) before the Cluster object goes.
            customTimeouts: { create: "60m", delete: "30m" },
        });

        const kubeconfig = new ClusterKubeconfig(`${name}/kubeconfig`, {
            rancherKubeconfig: args.rancher.cluster.kubeconfig,
            cluster: clusterName,
            rancherUrl: args.rancher.url,
            insecure: args.rancher.insecure,
        }, { parent: this, dependsOn: [this.cluster], deletedWith: this.cluster });
        this.provider = new k8s.Provider(`${name}/provider`, { kubeconfig: kubeconfig.kubeconfig, suppressHelmHookWarnings: true }, { parent: this });

        this.registerOutputs({});
    }
}
