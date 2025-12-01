import { dynamic } from "@pulumi/pulumi";
import * as pulumi from "@pulumi/pulumi";
import { RancherLoginInputs, RancherLoginProviderInputs, waitFor, RancherClient } from "@suse-tmm/utils";
import got from "got";

export interface ClusterIdArgs {
    rancher: RancherLoginInputs;
    clusterName: pulumi.Input<string>;
}

export interface ClusterIdProviderInputs{
    rancher: RancherLoginProviderInputs;
    clusterName: string;
}

export interface ClusterIdProviderOutputs extends ClusterIdProviderInputs{
    clusterId: string;
}

export class ClusterIdProvider implements dynamic.ResourceProvider<ClusterIdProviderInputs, ClusterIdProviderOutputs> {
    async create(inputs: ClusterIdProviderInputs): Promise<dynamic.CreateResult<ClusterIdProviderOutputs>> {
        return waitFor(() => this.fetchClusterId(inputs.rancher, inputs.clusterName).catch(err => {
            pulumi.log.error(`Failed to fetch cluster ID for ${inputs.clusterName}: ${err.message}`);
            throw new Error(`Failed to fetch cluster ID for ${inputs.clusterName}: ${err.message}`);
        }), {
            intervalMs: 5_000,
            timeoutMs: 30 * 1000, // 30 seconds timeout
        }).then((clusterId) => {
            return {
                id: inputs.clusterName,
                outs: {
                    ...inputs,
                    clusterId: clusterId!,
                },
            };
        });
    }

    async update(id: pulumi.ID, olds: ClusterIdProviderOutputs, news: ClusterIdProviderInputs): Promise<dynamic.UpdateResult<ClusterIdProviderOutputs>> {
        return {
            outs: { ...olds }
        }
    }

    async delete(id: pulumi.ID, props: ClusterIdProviderOutputs): Promise<void> {
        // No action needed for deletion
    }

    async fetchClusterId(rancher: RancherLoginProviderInputs, clusterName: string): Promise<string | undefined> {
        return RancherClient.fromServerConnectionArgs(rancher).then(client => {
            return client.get(`/apis/management.cattle.io/v3/clusters?displayName=${clusterName}`);
        }).then((response) => {
            const items = response.items;
            if (items.length === 0) {
                throw new Error(`Cluster with name ${clusterName} not found`);
            }
            return items[0].metadata.name;
        });
    }
}

export class ClusterId extends pulumi.dynamic.Resource {
    public readonly clusterId!: pulumi.Output<string>;

    constructor(name: string, args: ClusterIdArgs, opts?: pulumi.ResourceOptions) {
        super(new ClusterIdProvider(), name, {
            ...args,
            clusterId: undefined,
        }, opts);
    }
}