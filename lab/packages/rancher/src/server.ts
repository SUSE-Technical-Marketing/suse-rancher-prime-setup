import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ClusterAccess, helmApp, KubePatch, KubeWait, onCluster, withCluster } from "@lab/kubernetes";
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
    version: string;
    /** Full name, e.g. `rancher.rancher.lab.geeko.me`. */
    hostname: string;
    ingressClassName: string;
    /** Secret (in cattle-system, put there by Sprouter) with the wildcard certificate. */
    tlsSecretName: string;
    adminPassword: pulumi.Input<string>;
    insecure: boolean;
    /**
     * CA bundle (PEM) behind the certificate, when clients don't trust it by default (Let's
     * Encrypt staging). Rancher then serves it as `cacerts` and its agents trust only that.
     */
    privateCa?: string;
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
            metadata: { name: "tls-ca", namespace: new k8s.core.v1.Namespace(`${name}/namespace`, { metadata: { name: "cattle-system" } }, o).metadata.name },
            stringData: { "cacerts.pem": args.privateCa },
        }, o)] : [];

        const chart = helmApp(`${name}/chart`, {
            chart: "rancher",
            repo: "https://charts.rancher.com/server-charts/prime",
            version: args.version.replace(/^v/, ""),
            namespace: "cattle-system",
            values: {
                hostname: args.hostname,
                replicas: 1,
                ...(args.privateCa ? { privateCA: true, agentTLSMode: "strict" } : { agentTLSMode: "system-store" }),
                global: { cattle: { psp: { enabled: false } } },
                ingress: {
                    ingressClassName: args.ingressClassName,
                    tls: { source: "secret", secretName: args.tlsSecretName },
                },
            },
        }, { ...o, dependsOn: privateCa });

        const after = withCluster(args.cluster, this, { dependsOn: [chart] });
        const settings = [
            new KubePatch(`${name}/server-url`, {
                kubeconfig,
                path: "/apis/management.cattle.io/v3/settings/server-url",
                patch: { value: url },
            }, after),
            new KubePatch(`${name}/feature/harvester-baremetal-container-workload`, {
                kubeconfig,
                path: "/apis/management.cattle.io/v3/features/harvester-baremetal-container-workload",
                patch: { spec: { value: true } },
            }, after),
        ];

        // Rancher (and rancher-webhook) are fully up once the `local` cluster is Ready; creating
        // namespaces earlier races the webhook ("no endpoints available for service rancher-webhook").
        const local = new KubeWait(`${name}/local-ready`, {
            kubeconfig,
            path: "/apis/fleet.cattle.io/v1alpha1/namespaces/fleet-local/clusters/local",
            condition: "Ready",
            timeoutSeconds: 1200,
        }, after);

        const bootstrap = new RancherBootstrap(`${name}/admin-password`, {
            kubeconfig,
            url,
            insecure: args.insecure,
            password: args.adminPassword,
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
