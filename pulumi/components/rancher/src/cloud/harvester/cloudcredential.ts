import * as pulumi from "@pulumi/pulumi";
import { ClusterId } from "../../management/clusterid";
import { RancherKubeconfig } from "@suse-tmm/utils";
import { RancherLoginInputs } from "@suse-tmm/utils";
import { CloudCredential } from "../../resources/cloudcredential"

export interface HarvesterCloudCredentialArgs {
    rancher: RancherLoginInputs
    clusterName: pulumi.Input<string>;
    clusterId: pulumi.Input<string>;
}

export class HarvesterCloudCredential extends pulumi.ComponentResource {
    constructor(name: string, args: HarvesterCloudCredentialArgs, opts?: pulumi.ResourceOptions) {
        super("suse-tmm:rancher:cloudCredential", name, {}, opts);

        const downloadedKubeConfig = new RancherKubeconfig("harvester-cloud-credential-kubeconfig", {
            clusterId: args.clusterId,
            rancher: args.rancher,
        }, { parent: this });

        new CloudCredential("harvester-cloud-credential", {
            credentialName: args.clusterName,
            harvesterClusterId: args.clusterId,
            harvesterKubeconfig: downloadedKubeConfig.kubeconfig,
            annotations: {
                "provisioning.cattle.io/driver": "harvester",
            },
            rancher: args.rancher,
        }, { parent: this, dependsOn: [downloadedKubeConfig] });
    }
}
