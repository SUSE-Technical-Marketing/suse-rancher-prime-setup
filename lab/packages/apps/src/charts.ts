import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ClusterAccess, helmApp, onCluster } from "@lab/kubernetes";

interface ChartArgs {
    cluster: ClusterAccess;
    version: string;
}

/** Sprouter: copies secrets labelled `sprouter.geeko.me/enabled` into every namespace. */
export class Sprouter extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: ChartArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:Sprouter", name, {}, opts);
        this.release = helmApp(`${name}/chart`, {
            chart: "oci://ghcr.io/hierynomus/sprouter/charts/sprouter",
            version: args.version,
            namespace: "sprouter",
            values: { excludedNamespaces: ["kube-system", "kube-public", "cattle-local-user-passwords"] },
        }, onCluster(args.cluster, this));
        this.registerOutputs({});
    }
}

/** Outrider: propagates secrets annotated `outrider.geeko.me/enabled` to downstream clusters. */
export class Outrider extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: ChartArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:Outrider", name, {}, opts);
        this.release = helmApp(`${name}/chart`, {
            chart: "oci://ghcr.io/hierynomus/outrider/charts/outrider",
            version: args.version,
            namespace: "outrider",
            values: { defaultTargetNamespace: "default", logLevel: "info" },
        }, onCluster(args.cluster, this));
        this.registerOutputs({});
    }
}

export interface TraefikArgs extends ChartArgs {
    gatewayApi: { version: string; channel: "standard" | "experimental" };
    /** Annotations for Traefik's LoadBalancer Service, e.g. which load-balancer pool to use. */
    serviceAnnotations?: Record<string, string>;
    /** Install only after these (the cloud provider, so the Service gets an address). */
    after?: pulumi.Resource[];
}

/**
 * Traefik with its Kubernetes Gateway provider. Neither k3s/RKE2 nor the chart ship the Gateway
 * API CRDs, so they're applied first.
 */
export class Traefik extends pulumi.ComponentResource {
    readonly ingressClassName = "traefik";
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: TraefikArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:Traefik", name, {}, opts);
        const o = onCluster(args.cluster, this);
        const crds = new k8s.yaml.v2.ConfigFile(`${name}/gateway-api`, {
            file: `https://github.com/kubernetes-sigs/gateway-api/releases/download/${args.gatewayApi.version}/${args.gatewayApi.channel}-install.yaml`,
        }, o);
        this.release = helmApp(`${name}/chart`, {
            chart: "traefik",
            repo: "https://traefik.github.io/charts",
            version: args.version,
            namespace: "traefik",
            values: {
                providers: { kubernetesGateway: { enabled: true } },
                service: { annotations: args.serviceAnnotations ?? {} },
            },
        }, { ...o, dependsOn: [crds, ...(args.after ?? [])] });
        this.registerOutputs({});
    }
}
