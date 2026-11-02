// Catalog HelmCharts placed on hosts (`charts:`), installed after their profiles (DESIGN.md §17).

import type { ResolvedChartPlacement } from "../resolve";
import type { Resolution } from "./context";

/** Hosts' `charts:`, checked against the catalog. */
export function placeHostCharts(r: Resolution): void {
    const { lab, L, diags, catalog, hosts, walkRefs, describe } = r;
    const placeCharts = (placements: { name: string; namespace?: string; values?: Record<string, unknown> }[], at: string): ResolvedChartPlacement[] => {
        const placed: ResolvedChartPlacement[] = [];
        placements.forEach((p, i) => {
            const c = catalog.components[p.name]?.value;
            if (!c || c.kind !== "HelmChart") {
                const charts = Object.keys(catalog.components).filter(k => catalog.components[k].value.kind === "HelmChart").sort();
                diags.error(L, `${at}[${i}].name`, `no HelmChart "${p.name}" in the catalog; known: ${charts.join(", ")}`);
                return;
            }
            if (typeof c.version !== "string") {
                diags.error(L, `${at}[${i}].name`, `HelmChart ${p.name} has a version per Harvester minor; it can only be a Harvester add-on`);
                return;
            }
            const namespace = p.namespace ?? c.namespace;
            if (!namespace) {
                diags.error(L, `${at}[${i}].namespace`, `required: HelmChart ${p.name} has no default namespace`);
                return;
            }
            walkRefs(p.values ?? {}, `${at}[${i}].values`);
            placed.push({ name: p.name, chart: c.chart, ...(c.repo ? { repo: c.repo } : {}), version: c.version, namespace, values: p.values ?? {} });
        });
        return placed;
    };
    for (const host of hosts.values()) {
        const placements = lab.hosts[host.name]?.charts ?? [];
        if (placements.length === 0) continue;
        const at = `hosts.${host.name}.charts`;
        if (!host.capabilities.includes("kubernetes")) {
            diags.error(L, at, `needs ${describe("kubernetes")} on the host to install charts on`);
            continue;
        }
        host.charts.push(...placeCharts(placements, at));
    }
}
