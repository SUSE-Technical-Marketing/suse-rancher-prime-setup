import * as pulumi from "@pulumi/pulumi";
import { RancherClient, RancherLoginInputs, RancherLoginProviderInputs } from "@suse-tmm/utils";

export interface HarvesterClusterInputs {
    rancher: RancherLoginInputs;
    clusterName: pulumi.Input<string>;
}

export interface HarvesterClusterProviderInputs {
    rancher: RancherLoginProviderInputs;
    clusterName: string;
}

export interface HarvesterClusterProviderOutputs extends HarvesterClusterProviderInputs {
    clusterId: string;
}

export class HarvesterClusterProvider implements pulumi.dynamic.ResourceProvider {
    async create(inputs: HarvesterClusterProviderInputs): Promise<pulumi.dynamic.CreateResult<HarvesterClusterProviderOutputs>> {

        const clusterBody = {
            type: "cluster",
            name: inputs.clusterName,
            labels: {
                "provider.cattle.io": "harvester"
            },
            annotations: {
                "pulumi.com/waitFor": "condition=Created"
            }
        };

        // Here you would typically use the Rancher client to create the cluster
        // For example:
        return RancherClient.fromServerConnectionArgs(inputs.rancher).then(client => client.post("/v3/clusters", clusterBody)).then((resp) => {
            pulumi.log.info(`Harvester cluster ${inputs.clusterName} created with ID ${resp.id}`);
            return {
                id: inputs.clusterName,
                outs: {
                    clusterId: resp.id,
                    ...inputs,
                },
            };
        }).catch(err => {
            pulumi.log.error(`Failed to create Harvester cluster: ${err.message}`);
            throw new Error(`Failed to create Harvester cluster: ${err.message}`);
        });
    }

    async delete(id: pulumi.ID, props: HarvesterClusterProviderOutputs): Promise<void> {
    }

    async update(id: pulumi.ID, olds: HarvesterClusterProviderOutputs, news: HarvesterClusterProviderInputs): Promise<pulumi.dynamic.UpdateResult<HarvesterClusterProviderOutputs>> {
        return {
            outs: {
                ...olds,
            },
        };
    }
}

export class HarvesterCluster extends pulumi.dynamic.Resource {
    public readonly clusterId!: pulumi.Output<string>;
    constructor(name: string, args: HarvesterClusterInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new HarvesterClusterProvider(), name, {
            ...args,
            clusterId: undefined, // Placeholder, will be populated by the provider
         }, opts);
    }
}