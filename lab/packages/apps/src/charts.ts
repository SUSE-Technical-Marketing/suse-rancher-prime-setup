import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ClusterAccess, onCluster, ProfileChartSpec, profileHelmApp } from "@lab/kubernetes";

export interface ChartArgs {
    cluster: ClusterAccess;
    /** The chart, its namespace, and the Profile document's default and locked values. */
    chart: ProfileChartSpec;
    /** The lab's own values (the profile's `values` setting), merged over the engine's. */
    values?: pulumi.Input<Record<string, unknown>>;
}

export interface ChartProfileArgs extends ChartArgs {
    /** What it has to wait for: the outputs of the profiles it requires or uses. */
    after?: pulumi.Resource[];
}

/**
 * A profile that only installs its chart (Sprouter, Outrider, …): everything about it is in its
 * Profile document (namespace, default and locked values), so it needs no builder of its own.
 */
export class ChartProfile extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: ChartProfileArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:ChartProfile", name, {}, opts);
        this.release = profileHelmApp(`${name}/chart`, args.chart, { lab: args.values }, { ...onCluster(args.cluster, this), dependsOn: args.after ?? [] });
        this.registerOutputs({});
    }
}

export interface TraefikArgs extends ChartArgs {
    /** Install only after these (the Gateway API CRDs, the cloud provider so the Service gets an address). */
    after?: pulumi.Resource[];
}

/** Traefik with its Kubernetes Gateway provider (the Gateway API CRDs are the profile's first `charts` entry). */
export class Traefik extends pulumi.ComponentResource {
    readonly release: k8s.helm.v3.Release;

    constructor(name: string, args: TraefikArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:apps:Traefik", name, {}, opts);
        const o = onCluster(args.cluster, this);
        this.release = profileHelmApp(`${name}/chart`, args.chart, { lab: args.values }, { ...o, dependsOn: args.after ?? [] });
        this.registerOutputs({});
    }
}
