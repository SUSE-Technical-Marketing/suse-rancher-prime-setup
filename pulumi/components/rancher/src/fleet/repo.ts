import * as pulumi from "@pulumi/pulumi";
import { dynamic } from "@pulumi/pulumi";
import { RancherClient, RancherLoginInputs, RancherLoginProviderInputs } from "@suse-tmm/utils";

export interface GitRepoInputs {
    name: string;
    url: pulumi.Input<string>;
    branch?: pulumi.Input<string>;
    paths?: pulumi.Input<pulumi.Input<string>[]>;
    helmSecretName?: pulumi.Input<string>;
    clusterGroup?: pulumi.Input<string>;
    namespace?: pulumi.Input<string>;
}

export interface FleetRepoInputs {
    rancher: RancherLoginInputs;
    repos: GitRepoInputs[];
}

export interface GitRepo {
    name: string;
    url: string;
    branch?: string;
    paths?: string[];
    helmSecretName?: string;
    clusterGroup?: string;
    namespace?: string;
}

export interface FleetRepoProviderInputs {
    rancher: RancherLoginProviderInputs;
    repos: GitRepo[];
}

export interface FleetRepoProviderOutputs extends FleetRepoProviderInputs {
}

export class FleetRepoProvider implements dynamic.ResourceProvider<FleetRepoProviderInputs, FleetRepoProviderOutputs> {
    async create(inputs: FleetRepoProviderInputs): Promise<dynamic.CreateResult<FleetRepoProviderOutputs>> {

        await Promise.all(inputs.repos.map(async (repo) => {
            const body = {
                type: "fleet.cattle.io.gitrepo",
                metadata: {
                    namespace: repo.namespace || "fleet-default",
                    name: repo.name,
                },
                spec: {
                    repo: repo.url,
                    branch: repo.branch || "main",
                    paths: repo.paths || [],
                    correctDrift: { enabled: false },
                    pollingInterval: "60s",
                    insecureSkipTLSVerify: false,
                    helmSecretName: repo.helmSecretName,
                    targets: repo.clusterGroup ? [
                        {
                            clusterGroup: repo.clusterGroup,
                        }
                    ] : [],
                }
            }

            return RancherClient.fromServerConnectionArgs(inputs.rancher).then((client) =>
                client.post(`/v1/fleet.cattle.io.gitrepos`, body)
            ).catch((error) => {
                throw new Error(`Error creating Fleet GitRepo ${repo.name}: ${error}`);
            });
        })).catch((error) => {
            throw new Error(`Error creating Fleet GitRepos: ${error}`);
        });

        return {
            id: "fleet-repos",
            outs: { ...inputs },
        };
    }

    async update(id: pulumi.ID, olds: FleetRepoProviderOutputs, news: FleetRepoProviderInputs): Promise<dynamic.UpdateResult<FleetRepoProviderOutputs>> {
        // No action needed for update
        return {
            outs: { ...olds }
        };
    }

    async delete(id: pulumi.ID, props: FleetRepoProviderOutputs): Promise<void> {
        // No action needed for deletion
    }
}

export class FleetRepo extends pulumi.dynamic.Resource {
    constructor(name: string, args: FleetRepoInputs, opts?: pulumi.CustomResourceOptions) {
        super(new FleetRepoProvider(), name, args, opts);
    }
}