import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { fleet } from "@lab/crds";
import { KubeWait, onCluster, withCluster } from "@lab/kubernetes";
import { RancherAccess } from "./server";

export interface FleetRepo {
    name: string;
    url: string;
    branch?: string;
    paths?: string[];
    group?: string;
    namespace?: string;
    helmSecretName?: string;
    helmRepoURLRegex?: string;
}

const REPO = "https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git";

/** The lab-setup GitRepos of this repository's `apps/` tree (what `pulumi/` registers today). */
export const DEFAULT_REPOS: FleetRepo[] = [
    { name: "lab-setup-base", url: REPO, paths: ["/apps/base"], group: "all-downstream-clusters" },
    { name: "lab-setup-appco", url: REPO, paths: ["/apps/appco"], group: "all-downstream-clusters", helmSecretName: "application-collection-basicauth", helmRepoURLRegex: "oci://dp.apps.rancher.io/*" },
    { name: "lab-setup-suse", url: REPO, paths: ["/apps/suse"], helmSecretName: "scc-suse-basicauth", helmRepoURLRegex: "oci://registry.suse.com/*" },
    { name: "lab-setup-platform", url: REPO, paths: ["/apps/platform"] },
    { name: "lab-setup-local", url: REPO, paths: ["/apps/local"], namespace: "fleet-local" },
    { name: "lab-setup-thirdparty", url: REPO, paths: ["/apps/thirdparty"] },
    { name: "lab-setup-demos", url: REPO, paths: ["/apps/demos"] },
    { name: "ai-apps", url: REPO, paths: ["/apps/ai"], helmSecretName: "application-collection-basicauth", helmRepoURLRegex: "oci://dp.apps.rancher.io/*" },
];

type Creds = { username: pulumi.Input<string>; password: pulumi.Input<string> };

export interface FleetSecretsArgs {
    appco?: Creds;
    scc?: Creds;
    suseObservabilityLicense?: pulumi.Input<string>;
    certManager?: { email: string; cloudflareToken: pulumi.Input<string> };
}

export interface FleetArgs {
    rancher: RancherAccess;
    secrets?: FleetSecretsArgs;
    /** ClusterGroup name -> label selector. */
    groups: Record<string, Record<string, string>>;
    repos: FleetRepo[];
}

const block = (lines: Record<string, pulumi.Input<string>>) =>
    pulumi.all(lines).apply(values => Object.entries(values).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"));

/**
 * Fleet configuration: the secrets apps in `apps/` need (propagated downstream by Outrider), the
 * ClusterGroups and the GitRepos. All in `fleet-default` unless a repo says otherwise.
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
        const ns = "fleet-default";
        const s = args.secrets ?? {};

        const basicAuth = (secretName: string, creds: Creds) => new k8s.core.v1.Secret(`${name}/${secretName}`, {
            metadata: { name: secretName, namespace: ns },
            type: "kubernetes.io/basic-auth",
            stringData: { username: creds.username, password: pulumi.secret(creds.password) },
        }, o);
        const helmSecrets = new Set<string>();
        if (s.appco) { basicAuth("application-collection-basicauth", s.appco); helmSecrets.add("application-collection-basicauth"); }
        if (s.scc) { basicAuth("scc-suse-basicauth", s.scc); helmSecrets.add("scc-suse-basicauth"); }

        // Values files for the charts in apps/, delivered to downstream clusters by Outrider.
        const values: Record<string, pulumi.Output<string>> = {};
        if (s.appco) {
            values["appco-values.yaml"] = block({ username: s.appco.username, token: s.appco.password });
            values["harbor-values.yaml"] = pulumi.interpolate`registry:\n  credential:\n    access_key: ${JSON.stringify(s.appco.username)}\n    access_secret: ${pulumi.output(s.appco.password).apply(p => JSON.stringify(p))}`;
        }
        if (s.scc) values["suse-registry-values.yaml"] = block({ username: s.scc.username, token: s.scc.password });
        if (s.certManager) {
            values["cert-manager-values.yaml"] = pulumi.interpolate`letsencrypt:\n  prod:\n    email: ${JSON.stringify(s.certManager.email)}\ncloudflare:\n  token: ${pulumi.output(s.certManager.cloudflareToken).apply(t => JSON.stringify(t))}`;
        }
        if (s.suseObservabilityLicense) {
            values["suse-observability-values.yaml"] = pulumi.interpolate`global:\n  suseObservability:\n    license: ${pulumi.output(s.suseObservabilityLicense).apply(l => JSON.stringify(l))}`;
        }
        if (Object.keys(values).length > 0) {
            new k8s.core.v1.Secret(`${name}/fleet-secrets`, {
                metadata: {
                    name: "fleet-secrets",
                    namespace: ns,
                    annotations: { "outrider.geeko.me/enabled": "true", "outrider.geeko.me/namespace": "kube-system" },
                },
                stringData: pulumi.secret(pulumi.all(values)),
            }, o);
        }

        const groups = Object.entries(args.groups).map(([group, selector]) => new fleet.v1alpha1.ClusterGroup(`${name}/group/${group}`, {
            metadata: { name: group, namespace: ns },
            spec: { selector: { matchLabels: selector } },
        }, o));
        // The default repos target every downstream cluster except Harvester itself.
        const needsAllDownstream = args.repos.some(r => r.group === "all-downstream-clusters") && !args.groups["all-downstream-clusters"];
        if (needsAllDownstream) {
            groups.push(new fleet.v1alpha1.ClusterGroup(`${name}/group/all-downstream-clusters`, {
                metadata: { name: "all-downstream-clusters", namespace: ns },
                spec: { selector: { matchExpressions: [{ key: "provider.cattle.io", operator: "NotIn", values: ["harvester"] }] } },
            }, o));
        }

        for (const repo of args.repos) {
            // Fleet rejects a GitRepo whose Helm secret doesn't exist; skip it until it's configured.
            if (repo.helmSecretName && !helmSecrets.has(repo.helmSecretName)) {
                pulumi.log.warn(`Fleet repo ${repo.name} skipped: it needs the ${repo.helmSecretName} secret; set fleet.secrets.${repo.helmSecretName === "scc-suse-basicauth" ? "scc" : "appco"} in the rancher profile`, this);
                continue;
            }
            new fleet.v1alpha1.GitRepo(`${name}/repo/${repo.name}`, {
                metadata: { name: repo.name, namespace: repo.namespace ?? ns },
                spec: {
                    repo: repo.url,
                    branch: repo.branch ?? "main",
                    paths: repo.paths,
                    helmSecretName: repo.helmSecretName,
                    helmRepoURLRegex: repo.helmRepoURLRegex,
                    correctDrift: { enabled: false },
                    pollingInterval: "60s",
                    targets: repo.group ? [{ clusterGroup: repo.group }] : [],
                },
            }, { ...o, dependsOn: [crds, ...groups], ignoreChanges: ["spec.pollingInterval"] });
        }
        this.registerOutputs({});
    }
}
