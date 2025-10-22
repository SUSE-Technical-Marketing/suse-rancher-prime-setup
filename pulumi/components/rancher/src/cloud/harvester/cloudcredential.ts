import * as pulumi from "@pulumi/pulumi";
import { ClusterId } from "../../management/clusterid";
import { RancherKubeconfig } from "@suse-tmm/utils/src/resources/kubeconfig";
import { RancherLoginInputs } from "@suse-tmm/utils";
import { CloudCredential } from "../../resources/cloudcredential"

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

        new CloudCredential("harvester-cloud-credential", {
            credentialName: args.clusterName,
            harvesterClusterId: clusterId.clusterId,
            harvesterKubeconfig: downloadedKubeConfig.kubeconfig,
            annotations: {
                "provisioning.cattle.io/driver": "harvester",
            },
            ...args.rancher,
        }, { parent: this, dependsOn: [downloadedKubeConfig] });
    }
}
