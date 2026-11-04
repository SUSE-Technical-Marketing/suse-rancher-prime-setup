// Fleet (DESIGN.md §16.3): each Rancher host's repos and groups, and downstream clusters' Fleet
// profiles (their labels, annotations and outputs).

import { docAt } from "../documents";
import { resolveFleet, type FleetSettings } from "../fleet";
import { hostCapabilities } from "../profiles/rules";
import { renderTemplates } from "../templates";
import type { Resolution } from "./context";

/** Each Rancher host's Fleet repos and groups, and its UI plugins checked. */
export function resolveFleetRepos(r: Resolution): void {
    const { L, diags, catalog, registry, hosts, fleet, objects } = r;
    for (const host of hosts.values()) {
        const settings = host.profiles.rancher as { plugins?: string[] | Record<string, string>; fleet?: FleetSettings } | undefined;
        if (!settings) continue;
        const at = `hosts.${host.name}.profiles.rancher`;
        if (Array.isArray(settings.plugins)) {
            const known = catalog.plugins.value.versions;
            for (const plugin of settings.plugins.filter(p => !known[p])) {
                diags.error(L, `${at}.plugins`, `no UiPlugin "${plugin}" in the catalog; known: ${Object.keys(known).sort().join(", ")}`);
            }
        }
        fleet[host.name] = resolveFleet({
            catalog: catalog.fleet,
            fleet: settings.fleet ?? {},
            host: host.name,
            capabilities: hostCapabilities(registry, host.profiles),
            at,
            labSource: L,
            objects,
            diags,
        });
    }
}

/** Downstream clusters' Fleet profiles: their rules, labels, annotations and outputs. */
export function resolveFleetProfiles(r: Resolution): void {
    const { lab, L, diags, catalog, downstream } = r;
    for (const d of downstream) {
        const names = Object.keys(d.fleetProfiles ?? {});
        if (names.length === 0) continue;
        const at = `downstream.${d.name}.fleetProfiles`;
        const known = catalog.fleet.profiles;
        const caps = new Map<string, string[]>();
        for (const n of names) {
            const p = known[n]?.value;
            if (!p) {
                diags.error(L, `${at}.${n}`, `unknown Fleet profile "${n}"; known: ${Object.keys(known).sort().join(", ") || "none"}`);
                continue;
            }
            for (const c of [n, ...(p.provides ?? [])]) caps.set(c, [...(caps.get(c) ?? []), n]);
        }
        d.fleetCapabilities = [...caps.keys()].sort();
        const ctx = { lab: { name: lab.lab, domain: lab.domain, vars: lab.vars }, cluster: { name: d.name, type: d.type, rancher: d.rancher } };
        const set: Record<"labels" | "annotations", Record<string, { value: string; from: string }>> = { labels: {}, annotations: {} };
        for (const field of ["labels", "annotations"] as const) {
            for (const [k, v] of Object.entries(d[field] ?? {})) set[field][k] = { value: v, from: `the cluster's ${field}` };
        }
        for (const n of names.filter(n => known[n])) {
            const { value: p, source } = known[n];
            for (const r of p.requires ?? []) {
                if (!caps.has(r)) diags.error(L, `${at}.${n}`, `needs ${r}, which none of this cluster's Fleet profiles provides`);
            }
            for (const c of p.conflicts ?? []) {
                const others = (caps.get(c) ?? []).filter(o => o !== n);
                if (others.length > 0) diags.error(L, `${at}.${n}`, `conflicts with ${others.join(", ")} (both ${c})`);
            }
            for (const field of ["labels", "annotations"] as const) {
                for (const [k, template] of Object.entries(p[field] ?? {})) {
                    const value = String(renderTemplates(template, ctx, "", (_p, message) => diags.error(source, docAt("FleetProfile", n, `spec.${field}.${k}`), `${message} (on cluster ${d.name})`)));
                    const before = set[field][k];
                    if (before && before.value !== value) diags.error(L, `${at}.${n}`, `sets ${field === "labels" ? "label" : "annotation"} ${k} to "${value}", but ${before.from} has "${before.value}"`);
                    else set[field][k] = { value, from: `Fleet profile ${n}` };
                }
            }
        }
        const target = d as { labels?: Record<string, string>; annotations?: Record<string, string> };
        target.labels = Object.fromEntries(Object.entries(set.labels).map(([k, v]) => [k, v.value]));
        target.annotations = Object.fromEntries(Object.entries(set.annotations).map(([k, v]) => [k, v.value]));
        // What they say Fleet installs, for the engine: by capability, rendered for this cluster.
        const fleetOutputs: Record<string, Record<string, string>> = {};
        for (const n of names.filter(n => known[n])) {
            const { value: p, source } = known[n];
            for (const [cap, fields] of Object.entries(p.outputs ?? {})) {
                if (![n, ...(p.provides ?? [])].includes(cap)) {
                    diags.error(source, docAt("FleetProfile", n, `spec.outputs.${cap}`), `isn't a capability of this Fleet profile; it provides ${[n, ...(p.provides ?? [])].join(", ")}`);
                    continue;
                }
                fleetOutputs[cap] = Object.fromEntries(Object.entries(fields).map(([k, template]) => [k,
                    String(renderTemplates(template, ctx, "", (_p, message) => diags.error(source, docAt("FleetProfile", n, `spec.outputs.${cap}.${k}`), `${message} (on cluster ${d.name})`)))]));
            }
        }
        if (Object.keys(fleetOutputs).length > 0) d.fleetOutputs = fleetOutputs;
    }
}
