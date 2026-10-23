import type { ChartSpec, ProfileChartSpec } from "@lab/kubernetes";
import { renderTemplates, type ResolvedComponent, type ResolvedDistribution, type ResolvedHost, type ResolvedLab, type VersionValue } from "@lab/schema";

// Everything installed comes from the catalog's components (`lab/catalog/components.yaml`,
// overridable from the personal config and the lab file, DESIGN.md §16); the resolver hands over
// the merged result as `lab.components`.

function component(key: string, lab: ResolvedLab): ResolvedComponent {
    const c = lab.components[key];
    if (!c) throw new Error(`no catalog.components.${key} entry; add one to the lab file`);
    return c;
}

function plainVersion(key: string, v: VersionValue | undefined): string {
    if (v === undefined) throw new Error(`catalog.components.${key} has no version`);
    if (typeof v !== "string") throw new Error(`${key} has a version per Harvester minor; it can only be installed on a Harvester`);
    return v;
}

/** The version of `key`; a profile's own `version` setting wins. */
export function version(key: string, lab: ResolvedLab, own?: string): string {
    return own ?? plainVersion(key, component(key, lab).version);
}

/**
 * The version of a component that follows the Harvester it runs on (the vm-dhcp-controller
 * add-on). A plain version applies to every Harvester; for a per-minor map, an unknown (newer)
 * Harvester gets the newest version listed.
 */
export function harvesterVersion(key: string, lab: ResolvedLab, harvester: string | undefined): string {
    const v = component(key, lab).version;
    if (v === undefined) throw new Error(`catalog.components.${key} has no version`);
    if (typeof v === "string") return v;
    const minor = /^v?(\d+\.\d+)/.exec(harvester ?? "")?.[1];
    if (minor && v[minor]) return v[minor];
    const newest = Object.keys(v).sort((a, b) => {
        const [am, an] = a.split(".").map(Number), [bm, bn] = b.split(".").map(Number);
        return am - bm || an - bn;
    }).pop();
    if (!newest) throw new Error(`${key}: no versions listed`);
    return v[newest];
}

function chartOf(key: string, lab: ResolvedLab): { chart: string; repo?: string } {
    const c = component(key, lab);
    if (!("chart" in c)) throw new Error(`catalog.components.${key} isn't a chart`);
    return c.repo === undefined ? { chart: c.chart } : { chart: c.chart, repo: c.repo };
}

/** The catalog chart for `key` at its version; a profile's own `version` setting wins. */
export function chart(key: string, lab: ResolvedLab, own?: string): ChartSpec {
    return { ...chartOf(key, lab), version: version(key, lab, own) };
}

/** Like `chart`, for components that follow the Harvester they run on. */
export function harvesterChart(key: string, lab: ResolvedLab, harvester: string | undefined): ChartSpec {
    return { ...chartOf(key, lab), version: harvesterVersion(key, lab, harvester) };
}

/** A KubernetesDistribution document (`k3s`, `rke2`), as resolved. */
export function distribution(key: string, lab: ResolvedLab): ResolvedDistribution {
    const c = component(key, lab);
    if (c.kind !== "KubernetesDistribution") throw new Error(`catalog.components.${key} isn't a KubernetesDistribution`);
    return c;
}

/** A distribution's install command at a version (its `install` template, checked by the resolver). */
export function installCommand(d: ResolvedDistribution, version: string): string {
    const out = renderTemplates(d.install, { version }, "", (_p, message) => { throw new Error(`KubernetesDistribution install: ${message}`); });
    return String(out);
}

/** The catalog manifest URL template for `key`. */
export function manifest(key: string, lab: ResolvedLab): string {
    const c = component(key, lab);
    if (!("manifest" in c)) throw new Error(`catalog.components.${key} needs a manifest URL`);
    return c.manifest;
}

/**
 * A profile's chart: its HelmChart at its version (the profile's own `version` setting wins), the
 * namespace its Profile document names, and the document's default and locked values.
 */
export function profileChart(profile: string, host: ResolvedHost, lab: ResolvedLab, own?: string): ProfileChartSpec {
    const p = lab.profileCharts[profile];
    if (!p) throw new Error(`profile ${profile} has no charts in the catalog`);
    // Its own chart (the first in `charts`), with the values the resolver rendered for this host.
    const i = p.entries.findIndex(e => e.kind === "chart" && e.main);
    const main = p.entries[i];
    if (!main || main.kind !== "chart") throw new Error(`profile ${profile} has no chart of its own`);
    const values = host.chartValues[profile].entries[i];
    return { ...chart(main.chart, lab, own ?? values.version), namespace: main.namespace, defaults: values.values, lockedValues: values.lockedValues };
}
