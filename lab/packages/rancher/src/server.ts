import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ClusterAccess, KubePatch, KubeWait, onCluster, ProfileChartSpec, profileHelmApp, withCluster } from "@lab/kubernetes";
import { RancherBootstrap } from "./bootstrap";

/** How to talk to a running Rancher. */
export interface RancherAccess {
    url: string;
    username: string;
    password: pulumi.Output<string>;
    /** Let's Encrypt staging certificates aren't trusted. */
    insecure: boolean;
    cluster: ClusterAccess;
    /**
     * A provider for the Rancher cluster created after Rancher's CRDs exist. Kubernetes providers
     * cache API discovery, so the cluster's original provider doesn't know Rancher's kinds.
     */
    provider: k8s.Provider;
    /** Rancher is installed, its admin password set and its `local` cluster Ready. */
    ready: pulumi.Resource[];
}

export interface RancherServerArgs {
    cluster: ClusterAccess;
    /** The chart, its namespace, and the Profile document's default and locked values. */
    chart: ProfileChartSpec;
    /** The lab's own chart values, merged over the engine's (protected paths validated earlier). */
    values?: pulumi.Input<Record<string, unknown>>;
    /** Full name, e.g. `rancher.rancher.lab.geeko.me` (the chart's `hostname`, from its Profile's lockedValues). */
    hostname: string;
    adminPassword: pulumi.Input<string>;
    insecure: boolean;
    /**
     * CA bundle (PEM) behind the certificate, when clients don't trust it by default (Let's
     * Encrypt staging). Rancher then serves it as `cacerts` and its agents trust only that.
     */
    privateCa?: string;
    /** Rancher settings (`management.cattle.io` Settings) by name; `server-url` is the engine's. */
    settings: Record<string, string>;
    /** Feature flags by name. */
    features: Record<string, boolean>;
    /** Seconds to wait for Rancher to be up (its `local` cluster Ready, the admin password set). */
    timeoutSeconds: number;
}

/** Rancher Prime on a lab cluster, ready to log in to. */
export class RancherServer extends pulumi.ComponentResource {
    readonly access: RancherAccess;

    constructor(name: string, args: RancherServerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:Server", name, {}, opts);
        const o = onCluster(args.cluster, this);
        const kubeconfig = args.cluster.kubeconfig;
        const url = `https://${args.hostname}`;

        // The chart mounts `tls-ca` when privateCA is on, so it has to exist before Rancher starts.
        const privateCa = args.privateCa ? [new k8s.core.v1.Secret(`${name}/tls-ca`, {
            metadata: { name: "tls-ca", namespace: new k8s.core.v1.Namespace(`${name}/namespace`, { metadata: { name: args.chart.namespace } }, o).metadata.name },
            stringData: { "cacerts.pem": args.privateCa },
        }, o)] : [];

        // hostname, ingress and the (staging) CA settings come from the Profile's lockedValues.
        const chart = profileHelmApp(`${name}/chart`, { ...args.chart, version: args.chart.version.replace(/^v/, "") }, { lab: args.values }, { ...o, dependsOn: privateCa });

        const after = withCluster(args.cluster, this, { dependsOn: [chart] });
        if ("server-url" in args.settings) throw new Error(`${name}: the server-url setting is the lab's (${url})`);
        const timeoutSeconds = args.timeoutSeconds;
        const settings = [
            new KubePatch(`${name}/server-url`, {
                kubeconfig,
                path: "/apis/management.cattle.io/v3/settings/server-url",
                patch: { value: url },
                timeoutSeconds,
            }, after),
            ...Object.entries(args.settings).map(([setting, value]) => new KubePatch(`${name}/setting/${setting}`, {
                kubeconfig,
                path: `/apis/management.cattle.io/v3/settings/${setting}`,
                patch: { value },
                timeoutSeconds,
            }, after)),
            ...Object.entries(args.features).map(([feature, value]) => new KubePatch(`${name}/feature/${feature}`, {
                kubeconfig,
                path: `/apis/management.cattle.io/v3/features/${feature}`,
                patch: { spec: { value } },
                timeoutSeconds,
            }, after)),
        ];

        // Rancher (and rancher-webhook) are fully up once the `local` cluster is Ready; creating
        // namespaces earlier races the webhook ("no endpoints available for service rancher-webhook").
        const local = new KubeWait(`${name}/local-ready`, {
            kubeconfig,
            path: "/apis/fleet.cattle.io/v1alpha1/namespaces/fleet-local/clusters/local",
            condition: "Ready",
            timeoutSeconds,
        }, after);

        const bootstrap = new RancherBootstrap(`${name}/admin-password`, {
            kubeconfig,
            url,
            insecure: args.insecure,
            password: args.adminPassword,
            timeoutSeconds,
        }, withCluster(args.cluster, this, { dependsOn: [local] }));

        const provider = new k8s.Provider(`${name}/provider`, { kubeconfig, suppressHelmHookWarnings: true }, { parent: this, dependsOn: [local] });

        this.access = {
            url,
            username: "admin",
            password: pulumi.secret(pulumi.output(args.adminPassword)),
            insecure: args.insecure,
            cluster: args.cluster,
            provider,
            ready: [local, bootstrap, ...settings],
        };
        this.registerOutputs({ url });
    }
}
