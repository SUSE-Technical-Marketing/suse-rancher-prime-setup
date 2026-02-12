import * as pulumi from "@pulumi/pulumi";
import {fleet} from "@suse-tmm/rancher-crds";
import { KubeWait, noProvider, RancherLoginInputs } from "@suse-tmm/utils";
import * as kubernetes from "@pulumi/kubernetes";
import { Secret } from "@pulumi/kubernetes/core/v1";
import { FleetRepo } from "@suse-tmm/rancher";
interface GitRepoConfig {
    url: string;
    branch?: string;
    paths?: string[];
    helmSecretName?: string;
    clusterGroup?: string;
    namespace?: string;
}

const DefaultGitRepos: Record<string, GitRepoConfig> = {
    "lab-setup-base": {
        url: "https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git",
        branch: "main",
        paths: ["/apps/base"],
        clusterGroup: "all-downstream-clusters",
    },
    "lab-setup-appco": {
        url: "https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git",
        branch: "main",
        paths: ["/apps/appco"],
        helmSecretName: "application-collection-basicauth",
        clusterGroup: "all-downstream-clusters",
    },
    "lab-setup-suse": {
        url: "https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git",
        branch: "main",
        paths: ["/apps/suse"],
        helmSecretName: "scc-suse-basicauth",
    },
    "lab-setup-platform": {
        url: "https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git",
        branch: "main",
        paths: ["/apps/platform"],
    },
    "lab-setup-local": {
        url: "https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git",
        branch: "main",
        paths: ["/apps/local"],
        namespace: "fleet-local",
    }
};

export function createFleetConfiguration(labConfig: pulumi.Config, kubeconfig: pulumi.Input<string>, rancher: RancherLoginInputs, opts: pulumi.ResourceOptions) {

    const kw = new KubeWait("fleet-crds-wait", {
        apiVersion: "apiextensions.k8s.io/v1",
        kind: "CustomResourceDefinition",
        name: "gitrepos.fleet.cattle.io",
        kubeconfig: kubeconfig,
    }, noProvider(opts));

    new Secret("application-collection-basicauth", {
        metadata: {
            name: "application-collection-basicauth",
            namespace: "fleet-default",
        },
        type: "kubernetes.io/basic-auth",
        stringData: {
            username: labConfig.require("appcoUsername"),
            password: labConfig.requireSecret("appcoPassword"),
        },
    }, {...opts, retainOnDelete: true});

    new Secret("scc-suse-basicauth", {
        metadata: {
            name: "scc-suse-basicauth",
            namespace: "fleet-default",
        },
        type: "kubernetes.io/basic-auth",
        stringData: {
            username: labConfig.require("sccUsername"),
            password: labConfig.requireSecret("sccPassword"),
        },
    }, {...opts, retainOnDelete: true});

    // Need to refresh the provider to pick up the new CRDs
    const newProvider = new kubernetes.Provider("refreshed-rancher-k8s", { kubeconfig: kubeconfig }, { dependsOn: [kw] });
    opts = {...opts, provider: newProvider};

    const cg = new fleet.ClusterGroup("all-downstream-clusters", {
        metadata: {
            name: "all-downstream-clusters",
            namespace: "fleet-default",
        },
        spec: {
            selector: {
                matchExpressions: [
                    {
                        key: "provider.cattle.io",
                        operator: "NotIn",
                        values: ["harvester"],
                    },
                ],
            }
        }
    }, {...opts, dependsOn: [kw], retainOnDelete: true});

    new FleetRepo("fleet-git-repos", {
        rancher: rancher,
        repos: Object.entries(DefaultGitRepos).map(([name, cfg]) => ({
            name: name,
            url: cfg.url,
            branch: cfg.branch,
            paths: cfg.paths,
            helmSecretName: cfg.helmSecretName,
            clusterGroup: cfg.clusterGroup,
            namespace: cfg.namespace,
        })),
    }, {...noProvider(opts), dependsOn: [kw, cg] });
}
