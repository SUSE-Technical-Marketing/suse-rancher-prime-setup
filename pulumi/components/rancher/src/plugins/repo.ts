import * as pulumi from "@pulumi/pulumi";
import { ClusterRepo } from "@suse-tmm/rancher-crds";

interface RepoConfig {
    gitRepo?: string;
    gitBranch?: string;
    httpRepo?: string;
}

const DefaultRepos: Record<string, RepoConfig> = {
    "rancher-ui-plugins": {
        gitRepo: "https://github.com/rancher/ui-plugin-charts",
        gitBranch: "main",
    },
    "virtual-clusters": {
        httpRepo: "https://rancher.github.io/virtual-clusters-ui",
    },
}

export function installUIPluginRepo(opts?: pulumi.ComponentResourceOptions): Map<string, ClusterRepo> {
    const repos = new Map<string, ClusterRepo>();

    for (const [name, config] of Object.entries(DefaultRepos)) {
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
        }, opts);

        repos.set(name, repo);
    }

    return repos;
}
