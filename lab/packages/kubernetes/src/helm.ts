import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface HelmAppArgs {
    chart: string;
    version: pulumi.Input<string>;
    /** Chart repository URL; leave out for `oci://` charts. */
    repo?: string;
    namespace: string;
    /** Release name; defaults to the chart's last path segment. */
    releaseName?: string;
    values?: pulumi.Input<Record<string, unknown>>;
}

/**
 * A Helm release in its own namespace, waited on until its resources are ready. Unlike the
 * `pulumi/` setup nothing is retained on delete: the lab owns its clusters.
 */
export function helmApp(name: string, args: HelmAppArgs, opts: pulumi.CustomResourceOptions): k8s.helm.v3.Release {
    const releaseName = args.releaseName ?? args.chart.split("/").pop()!;
    return new k8s.helm.v3.Release(name, {
        name: releaseName,
        chart: args.chart,
        version: args.version,
        namespace: args.namespace,
        createNamespace: true,
        ...(args.repo ? { repositoryOpts: { repo: args.repo } } : {}),
        values: args.values ?? {},
        timeout: 900,
    }, opts);
}
