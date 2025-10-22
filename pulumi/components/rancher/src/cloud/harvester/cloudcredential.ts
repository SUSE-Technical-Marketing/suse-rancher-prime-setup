import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import got from "got";
import { ClusterId } from "../../management/clusterid";
import { KubeConfig, RancherKubeconfig } from "@suse-tmm/utils/src/resources/kubeconfig";
import * as kubernetes from "@pulumi/kubernetes";
import { RancherLoginInputs } from "@suse-tmm/utils";

export interface HarvesterCloudCredentialArgs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Rancher cluster
    rancher: RancherLoginInputs
    clusterName: pulumi.Input<string>;
}

export class HarvesterCloudCredential extends pulumi.ComponentResource {
    constructor(name: string, args: HarvesterCloudCredentialArgs, opts?: pulumi.ResourceOptions) {
        super("suse-tmm:rancher:cloudCredential", name, {}, opts);

        const clusterId = new ClusterId("cloud-credential-cluster-id", {
            kubeconfig: args.kubeconfig,
            clusterName: args.clusterName,
        }, { parent: this });

        const downloadedKubeConfig = new RancherKubeconfig("harvester-cloud-credential-kubeconfig", {
            clusterId: clusterId.clusterId,
            ...args.rancher,
        }, { parent: this, dependsOn: [clusterId] });

        new kubernetes.core.v1.Secret("harvester-cloud-credential", {
            metadata: {
                name: pulumi.interpolate`${args.clusterName}-cloud-credential`,
                namespace: "cattle-global-data",
                annotations: {
                    "field.cattle.io/name": args.clusterName,
                    "provisioning.cattle.io/driver": "harvester"
                },
            },
            stringData: {
                "harvesterCredentialConfig-kubeconfigContent": downloadedKubeConfig.kubeconfig,
                "harvesterCredentialConfig-clusterId": clusterId.clusterId,
                "harvesterCredentialConfig-clusterType": "imported",
            },
            type: "Opaque",
        }, { parent: this, dependsOn: [downloadedKubeConfig] });
    }
}
