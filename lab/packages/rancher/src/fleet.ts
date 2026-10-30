import * as pulumi from "@pulumi/pulumi";
import { fleet, types } from "@lab/crds";
import { KubeWait, onCluster, withCluster } from "@lab/kubernetes";
import type { ResolvedFleet } from "@lab/schema";
import { RancherAccess } from "./server";

export interface FleetArgs {
    rancher: RancherAccess;
    /** The lab's Fleet repos and groups, resolved from the catalog (DESIGN.md §16.3). */
    fleet: ResolvedFleet;
    /** The secrets the repos use (catalog secrets on the Rancher cluster): GitRepos wait for them. */
    after?: pulumi.Resource[];
    /** Seconds to wait for Fleet's CRDs. */
    timeoutSeconds: number;
}

/**
 * Fleet configuration from the catalog: ClusterGroups, GitRepos and HelmOps. What to create is all decided
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
            timeoutSeconds: args.timeoutSeconds,
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

        // HelmOps: Fleet's agents pull the chart from its repo, so it never goes into the Bundle (etcd's limit).
        if (args.fleet.helmOps.length > 0) {
            const helmOpCrd = new KubeWait(`${name}/crds-helmops`, {
                kubeconfig: rancher.cluster.kubeconfig,
                path: "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/helmops.fleet.cattle.io",
                condition: "Established",
                timeoutSeconds: args.timeoutSeconds,
            }, withCluster(rancher.cluster, this, { dependsOn: rancher.ready }));
            for (const op of args.fleet.helmOps) {
                new fleet.v1alpha1.HelmOp(`${name}/helmop/${op.name}`, {
                    metadata: { name: op.name, namespace: op.namespace },
                    spec: {
                        helm: {
                            repo: op.repo,
                            chart: op.chart,
                            version: op.version,
                            releaseName: op.releaseName,
                            values: op.values,
                            valuesFrom: op.valuesFrom as types.input.fleet.v1alpha1.HelmOpSpecHelmValuesFrom[] | undefined,
                        },
                        defaultNamespace: op.defaultNamespace,
                        labels: op.labels,
                        helmSecretName: op.helmSecret,
                        diff: op.diff as types.input.fleet.v1alpha1.HelmOpSpecDiff | undefined,
                        correctDrift: { enabled: false },
                        targets: op.target ? [{ clusterGroup: op.target }] : op.selector ? [{ clusterSelector: op.selector }] : [],
                    },
                }, { ...o, dependsOn: [helmOpCrd, ...groups, ...(args.after ?? [])] });
            }
        }
        this.registerOutputs({});
    }
}
