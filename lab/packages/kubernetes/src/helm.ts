import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/** A chart from the catalog (DESIGN.md §16.2) at a version: `repo` unless it's an `oci://` chart. */
export interface ChartSpec {
    chart: string;
    repo?: string;
    version: string;
}

/**
 * A profile's chart (DESIGN.md §17): the chart at its version, the namespace its Profile document
 * names, and the document's default and locked values.
 */
export interface ProfileChartSpec extends ChartSpec {
    namespace: string;
    defaults: Record<string, unknown>;
    lockedValues: Record<string, unknown>;
}

export interface HelmAppArgs extends ChartSpec {
    namespace: string;
    /** Release name; defaults to the chart's last path segment. */
    releaseName?: string;
    /** Defaults (a Profile's `values`), under everything else. */
    defaults?: Record<string, unknown>;
    /** The values the component computes. */
    values?: pulumi.Input<Record<string, unknown>>;
    /** The lab's own values for this chart, merged over `values` (protected paths are validated earlier). */
    extraValues?: pulumi.Input<Record<string, unknown>>;
    /** Merged last (a Profile's `lockedValues`). */
    lockedValues?: Record<string, unknown>;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `over` merged into `base`: maps merge key by key, everything else (lists too) is replaced. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(over)) {
        out[key] = isMap(value) && isMap(out[key]) ? deepMerge(out[key] as Record<string, unknown>, value) : value;
    }
    return out;
}

/** A chart's values: profile defaults, then what the component computes, then the lab's, then locked values. */
export function mergeValues(...layers: Record<string, unknown>[]): Record<string, unknown> {
    return layers.reduce<Record<string, unknown>>((acc, v) => deepMerge(acc, v), {});
}

/**
 * A Helm release in its own namespace, waited on until its resources are ready. Unlike the
 * `pulumi/` setup nothing is retained on delete: the lab owns its clusters.
 */
export function helmApp(name: string, args: HelmAppArgs, opts: pulumi.CustomResourceOptions): k8s.helm.v3.Release {
    const releaseName = args.releaseName ?? args.chart.split("/").pop()!;
    const values = pulumi.all([args.values ?? {}, args.extraValues ?? {}]).apply(([computed, extra]) =>
        mergeValues(args.defaults ?? {}, computed as Record<string, unknown>, extra as Record<string, unknown>, args.lockedValues ?? {}));
    return new k8s.helm.v3.Release(name, {
        name: releaseName,
        chart: args.chart,
        version: args.version,
        namespace: args.namespace,
        createNamespace: true,
        ...(args.repo ? { repositoryOpts: { repo: args.repo } } : {}),
        values,
        timeout: 900,
    }, opts);
}

/**
 * A profile's chart: in the namespace its Profile document names, with the document's values
 * under the component's computed `values`, the lab's `extraValues` over those, and locked values last.
 */
export function profileHelmApp(
    name: string, chart: ProfileChartSpec,
    values: { computed?: pulumi.Input<Record<string, unknown>>; lab?: pulumi.Input<Record<string, unknown>> },
    opts: pulumi.CustomResourceOptions,
): k8s.helm.v3.Release {
    const { defaults, lockedValues, ...spec } = chart;
    return helmApp(name, { ...spec, defaults, lockedValues, values: values.computed, extraValues: values.lab }, opts);
}
