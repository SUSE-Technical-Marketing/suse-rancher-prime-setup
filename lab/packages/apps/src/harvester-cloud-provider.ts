import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { onCluster, profileHelmApp } from "@lab/kubernetes";
import { ChartArgs } from "./charts";

export interface HarvesterCloudProviderArgs extends ChartArgs {
    /** Kubeconfig for the cloud provider's Harvester service account (secret). */
    cloudConfig: pulumi.Input<string>;
}


/**
 * The Harvester cloud provider in a guest cluster: LoadBalancer services get an address from the
 * Harvester load-balancer pool of the VM's network, announced by kube-vip from the guest.
 */
export class HarvesterCloudProvider extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: HarvesterCloudProviderArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:HarvesterCloudProvider", name, {}, opts);
        const o = onCluster(args.cluster, this);
        // The chart reads the secret its Profile's lockedValues name (cloudConfig.secretName/secretKey).
        const ref = (args.chart.lockedValues.cloudConfig ?? {}) as { secretName?: string; secretKey?: string };
        if (!ref.secretName || !ref.secretKey) throw new Error("Profile/harvester-cloud-provider needs lockedValues.cloudConfig.secretName and secretKey");
        const secret = new k8s.core.v1.Secret(`${name}/cloud-config`, {
            metadata: { name: ref.secretName, namespace: args.chart.namespace },
            stringData: { [ref.secretKey]: pulumi.secret(args.cloudConfig) },
        }, o);
        this.release = profileHelmApp(`${name}/chart`, args.chart, { lab: args.values }, { ...o, dependsOn: [secret] });
        this.registerOutputs({});
    }
}
