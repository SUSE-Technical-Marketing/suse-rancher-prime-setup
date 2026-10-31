import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ClusterAccess, onCluster, ProfileChartSpec, profileHelmApp } from "@lab/kubernetes";

export interface ChartArgs {
    /** Where it goes: a host's cluster, or a downstream cluster through Rancher. */
    cluster: Pick<ClusterAccess, "provider" | "deletedWith">;
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
