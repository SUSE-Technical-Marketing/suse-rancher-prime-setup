import * as pulumi from "@pulumi/pulumi";
import { ClusterRepo } from "../../generated/catalog/v1";

export interface RepoConfig {
    gitRepo?: string;
    gitBranch?: string;
    httpRepo?: string;
}

const DefaultRepos: Record<string, RepoConfig> = {
    "rancher-ui-plugins": {
        gitRepo: "https://github.com/rancher/ui-plugin-charts",
        gitBranch: "main",
    },
}

export function defaultUIPluginRepos(opts?: pulumi.ComponentResourceOptions): Record<string, ClusterRepo> {
    const repos: Record<string, ClusterRepo> = {};
    for (const [name, config] of Object.entries(DefaultRepos)) {
        repos[name] = installUIPluginRepo(name, config, opts);
    }
    return repos;
}

export function installUIPluginRepo(name: string, config: RepoConfig, opts?: pulumi.ComponentResourceOptions): ClusterRepo {
    const repo = new ClusterRepo(name, {
        metadata: {
            name: name,
            annotations: {
                "pulumi.com/waitFor": "condition=Downloaded",
            }
        },
        spec: {
            url: config.httpRepo,
            gitRepo: config.gitRepo,
            gitBranch: config.gitBranch
        }
    }, {...opts, retainOnDelete: true});
    return repo;
}
