import * as pulumi from "@pulumi/pulumi";
import { ClusterRepo } from "@suse-tmm/rancher-crds";

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
    "security-ui": {
        gitRepo: "https://github.com/neuvector/security-ui-exts.git",
        gitBranch: "gh-pages",
    },
    "virtual-clusters": {
        httpRepo: "https://rancher.github.io/virtual-clusters-ui",
    },
}

export function defaultUIPluginRepos(opts?: pulumi.ComponentResourceOptions): Map<string, ClusterRepo> {
    const repos = new Map<string, ClusterRepo>();
    for (const [name, config] of Object.entries(DefaultRepos)) {
        const repo = installUIPluginRepo(name, config, opts);
        repos.set(name, repo);
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
    }, opts);
    return repo;
}
