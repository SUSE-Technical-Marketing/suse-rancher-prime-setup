import * as pulumi from "@pulumi/pulumi";
import { fleet } from "@lab/crds";
import { KubeWait, onCluster, withCluster } from "@lab/kubernetes";
import type { ResolvedFleet } from "@lab/schema";
import { RancherAccess } from "./server";

export interface FleetArgs {
    rancher: RancherAccess;
    /** The lab's Fleet repos and groups, resolved from the catalog (DESIGN.md §16.3). */
    fleet: ResolvedFleet;
    /** The secrets the repos use (catalog secrets on the Rancher cluster): GitRepos wait for them. */
    after?: pulumi.Resource[];
}

/**
 * Fleet configuration from the catalog: ClusterGroups and GitRepos. What to create is all decided
 * by the resolver; the secrets the repos need are created as catalog objects on the Rancher cluster.
 */
export class Fleet extends pulumi.ComponentResource {
    constructor(name: string, args: FleetArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:Fleet", name, {}, opts);
        const { rancher } = args;

        const crds = new KubeWait(`${name}/crds`, {
            kubeconfig: rancher.cluster.kubeconfig,
            path: "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/gitrepos.fleet.cattle.io",
            condition: "Established",
        }, withCluster(rancher.cluster, this, { dependsOn: rancher.ready }));
        const o: pulumi.CustomResourceOptions = { ...onCluster(rancher.cluster, this), provider: rancher.provider, dependsOn: [crds] };

        const groups = Object.entries(args.fleet.groups).map(([group, selector]) => new fleet.v1alpha1.ClusterGroup(`${name}/group/${group}`, {
            metadata: { name: group, namespace: "fleet-default" },
            spec: { selector },
        }, o));

        for (const repo of args.fleet.repos) {
            new fleet.v1alpha1.GitRepo(`${name}/repo/${repo.name}`, {
                metadata: { name: repo.name, namespace: repo.namespace },
                spec: {
                    repo: repo.url,
                    branch: repo.branch,
                    paths: repo.paths,
                    helmSecretName: repo.helm?.secret,
                    helmRepoURLRegex: repo.helm?.repoURLRegex,
                    correctDrift: { enabled: false },
                    pollingInterval: "60s",
                    targets: repo.target ? [{ clusterGroup: repo.target }] : [],
                },
            }, { ...o, dependsOn: [crds, ...groups, ...(args.after ?? [])], ignoreChanges: ["spec.pollingInterval"] });
        }
        this.registerOutputs({});
    }
}
