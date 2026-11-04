// Profiles on Harvesters themselves (the DNS controller, an observability agent).

import { profileTargets } from "../profiles/define";
import { checkHarvesterProfiles, hostCapabilities } from "../profiles/rules";
import type { Credentials } from "../schema";
import type { Resolution } from "./context";

/** Harvesters' own profiles: those that go on a Harvester, checked. */
export function resolveHarvesterProfiles(r: Resolution): void {
    const { lab, L, diags, registry, harvesters, forTarget, parseProfiles, renderProfile, useCredentials, useSecretOrString, useTemplate } = r;
    for (const h of harvesters.values()) {
        const asked = Object.entries(lab.harvesters[h.name]?.profiles ?? {});
        if (asked.length === 0) continue;
        const at = `harvesters.${h.name}`;
        const own: Record<string, Record<string, unknown>> = {};
        for (const [n, settings] of asked) {
            const def = registry[n];
            if (def && profileTargets(def).includes("harvester")) own[n] = settings;
            else diags.error(L, `${at}.profiles.${n}`, `${def ? "doesn't go on a Harvester" : `unknown profile "${n}"`}; a Harvester takes: ${forTarget("harvester").join(", ") || "none"}`);
        }
        h.profiles = parseProfiles(own, at);
        checkHarvesterProfiles({
            registry,
            harvester: { name: h.name, profiles: h.profiles },
            error: (path, message) => diags.error(L, path, message),
            secretField: (value, path, shape) => {
                if (value === undefined) return;
                if (shape === "credentials") useCredentials(value as Credentials, L, path);
                else useSecretOrString(value as string, L, path);
            },
            secretTemplate: (template, path) => useTemplate(template, "string", L, path),
        });
        // A ChartProfile on a Harvester is an add-on: its chart's values and its objects, rendered here.
        // Imported into a Rancher of the lab: a Harvester downstream cluster runs on it.
        const imported = r.downstream.some(d => d.type === "harvester" && d.harvester === h.name);
        const capabilities = [...hostCapabilities(registry, h.profiles).keys(), "kubernetes"].sort();
        const target = { kind: "harvester" as const, name: h.name, fqdn: new URL(h.url).hostname, capabilities, imported };
        for (const n of Object.keys(h.profiles)) {
            const rendered = renderProfile(n, h.profiles, {}, { target }, `Harvester ${h.name}`);
            if (rendered) h.chartValues[n] = rendered;
        }
    }
}
