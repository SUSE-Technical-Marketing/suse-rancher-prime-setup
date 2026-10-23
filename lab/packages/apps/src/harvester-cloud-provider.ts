import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ClusterAccess, helmApp, onCluster } from "@lab/kubernetes";

export interface HarvesterCloudProviderArgs {
    cluster: ClusterAccess;
    version: string;
    /** Kubeconfig for the cloud provider's Harvester service account (secret). */
    cloudConfig: pulumi.Input<string>;
    /** Guest cluster name, as Harvester's load balancers and the DNS controller know it. */
    clusterName: string;
}

/** Annotation that makes the cloud provider take a LoadBalancer's address from the IP pool. */
export const HARVESTER_POOL_ANNOTATIONS = { "cloudprovider.harvesterhci.io/ipam": "pool" };

/**
 * The Harvester cloud provider in a guest cluster: LoadBalancer services get an address from the
 * Harvester load-balancer pool of the VM's network, announced by kube-vip from the guest.
 */
export class HarvesterCloudProvider extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: HarvesterCloudProviderArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:HarvesterCloudProvider", name, {}, opts);
        const o = onCluster(args.cluster, this);
        const secret = new k8s.core.v1.Secret(`${name}/cloud-config`, {
            metadata: { name: "harvester-cloud-config", namespace: "kube-system" },
            stringData: { "cloud-config": pulumi.secret(args.cloudConfig) },
        }, o);
        this.release = helmApp(`${name}/chart`, {
            chart: "harvester-cloud-provider",
            repo: "https://charts.harvesterhci.io",
            version: args.version,
            namespace: "kube-system",
            values: {
                cloudConfig: { secretName: secret.metadata.name, secretKey: "cloud-config" },
                global: { cattle: { clusterName: args.clusterName } },
            },
        }, { ...o, dependsOn: [secret] });
        this.registerOutputs({});
    }
}
