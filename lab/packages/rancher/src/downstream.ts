import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { provisioning, rke_machine_config } from "@lab/crds";
import { NodeDriverClusterArgs, nodeDriverCluster, NodePool, NS, toGiB } from "./node-driver-cluster";

export interface HarvesterMachinePool extends NodePool {
    cpu: number;
    memory: string;
    disk: string;
    /** Image on the Harvester, `namespace/name`. */
    image: pulumi.Input<string>;
    /** VM network, `namespace/name`. */
    network: pulumi.Input<string>;
    userData: pulumi.Input<string>;
}

export interface HarvesterClusterArgs extends NodeDriverClusterArgs {
    distro: "rke2" | "k3s";
    /** Namespace on the Harvester the VMs go in. */
    vmNamespace: pulumi.Input<string>;
    /** Login rancher-machine uses on the VMs; the pools' user data has to create it. */
    sshUser: string;
    /** Kubeconfig for the Harvester cloud provider in the new cluster (RKE2 only). */
    cloudProviderConfig?: pulumi.Input<string>;
    pools: HarvesterMachinePool[];
}

/**
 * A cluster Rancher provisions on an imported Harvester: one `HarvesterConfig` per machine pool,
 * and with RKE2 the Harvester cloud provider (its kubeconfig in a secret Rancher hands the cluster).
 */
export class HarvesterCluster extends pulumi.ComponentResource {
    readonly cluster: provisioning.v1.Cluster;
    /** A provider for the new cluster (through Rancher); resources on it are deleted with the cluster. */
    readonly provider: k8s.Provider;
    /** Rancher's management cluster id (`c-m-...`). */
    readonly clusterId: pulumi.Output<string>;
    /** Its kubeconfig through Rancher (secret), for checks the provider can't make (a webhook's admission). */
    readonly kubeconfig: pulumi.Output<string>;

    constructor(name: string, args: HarvesterClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:HarvesterCluster", name, {}, opts);
        const built = nodeDriverCluster(this, name, args, args.pools, (o, clusterName) => {
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

            return {
                kind: "HarvesterConfig",
                machineConfigs,
                ...(cloudConfig ? {
                    machineSelectorConfig: { "cloud-provider-name": "harvester", "cloud-provider-config": pulumi.interpolate`secret://${NS}:${cloudConfig.metadata.name}` },
                    chartValues: {
                        "harvester-cloud-provider": {
                            clusterName,
                            cloudConfigPath: `${args.distribution.dataDir}/etc/config-files/cloud-provider-config`,
                        },
                    },
                    dependsOn: [cloudConfig],
                } : {}),
            };
        });
        this.cluster = built.cluster;
        this.provider = built.provider;
        this.clusterId = built.clusterId;
        this.kubeconfig = built.kubeconfig;
        this.registerOutputs({});
    }
}
