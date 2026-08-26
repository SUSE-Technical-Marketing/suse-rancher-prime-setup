import { dynamic } from "@pulumi/pulumi";
import * as pulumi from "@pulumi/pulumi";
import { RancherLoginInputs, RancherLoginProviderInputs, waitFor, RancherClient } from "@suse-tmm/common";

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

    async read(id: pulumi.ID, props?: ClusterIdProviderOutputs): Promise<dynamic.ReadResult<ClusterIdProviderOutputs>> {
        if (!props) return { id, props: {} as ClusterIdProviderOutputs };
        const clusterId = await this.fetchClusterId(props.rancher, props.clusterName).catch(() => props.clusterId);
        return {
            id,
            props: { ...props, clusterId: clusterId ?? props.clusterId },
        };
    }

    async fetchClusterId(rancher: RancherLoginProviderInputs, clusterName: string): Promise<string | undefined> {
        return RancherClient.fromServerConnectionArgs(rancher).then(async (client) => {
            const filtered = await client.get("/apis/management.cattle.io/v3/clusters", { displayName: clusterName });
            const filteredItems = filtered.items ?? filtered.data ?? [];

            const filteredMatches = this.findExactMatches(filteredItems, clusterName);
            if (filteredMatches.length === 1) {
                return filteredMatches[0];
            }
            if (filteredMatches.length > 1) {
                throw new Error(`Multiple clusters matched display name '${clusterName}' in filtered query: ${filteredMatches.join(", ")}`);
            }

            const full = await client.get("/apis/management.cattle.io/v3/clusters");
            const fullItems = full.items ?? full.data ?? [];
            const fullMatches = this.findExactMatches(fullItems, clusterName);
            if (fullMatches.length === 1) {
                return fullMatches[0];
            }
            if (fullMatches.length > 1) {
                throw new Error(`Multiple clusters matched display name '${clusterName}': ${fullMatches.join(", ")}`);
            }

            throw new Error(`Cluster with name ${clusterName} not found`);
        });
    }

    private findExactMatches(items: any[], wantedName: string): string[] {
        return items
            .filter(item => this.getCandidateNames(item).includes(wantedName))
            .map(item => this.getClusterId(item))
            .filter((id): id is string => !!id);
    }

    private getCandidateNames(item: any): string[] {
        return [
            item?.displayName,
            item?.name,
            item?.metadata?.name,
            item?.spec?.displayName,
            item?.status?.displayName,
        ].filter((v): v is string => typeof v === "string" && v.length > 0);
    }

    private getClusterId(item: any): string | undefined {
        const id = item?.metadata?.name ?? item?.id;
        return typeof id === "string" && id.length > 0 ? id : undefined;
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