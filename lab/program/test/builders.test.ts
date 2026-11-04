import { describe, expect, it } from "vitest";
import { loadCatalog, profileTargets } from "@lab/schema";
import { BUILDERS, builderOf } from "../profiles";

describe("profile builders", () => {
    const { catalog } = loadCatalog({ personalConfig: "/nonexistent/lab-config.yaml" });

    it("cover every profile: its own builder, the Kubernetes one for a distribution, or the generic one for a chart-only profile", () => {
        // Planned profiles aren't built yet: `lab up` refuses labs that use them. A ResourceProfile has the generic one too.
        const missing = Object.values(catalog!.profiles).filter(p => p.status !== "planned" && !BUILDERS[p.name as keyof typeof BUILDERS] && !p.distribution && !p.chart && p.kind !== "resource").map(p => p.name);
        expect(missing).toEqual([]);
    });

    it("have a step for every target a profile declares", () => {
        // A ChartProfile's generic builder covers hosts and clusters; builderOf needs its chart entry.
        const profiles = Object.values(catalog!.profiles);
        const lab = {
            profileCharts: Object.fromEntries(profiles.filter(p => p.chart || p.kind === "resource").map(p => [p.name, {}])),
            profiles: Object.fromEntries(profiles.map(p => [p.name, { provides: [], waitFor: [], distribution: p.distribution }])),
        } as never;
        const steps = { host: ["host", "setup", "boot", "cloudInit", "last"], cluster: ["cluster", "last"], harvester: ["harvester", "last"] } as const;
        const missing = Object.values(catalog!.profiles).filter(p => p.status !== "planned").flatMap(p => {
            const builder = builderOf(lab, p.name) as Record<string, unknown>;
            return profileTargets(p).filter(t => !steps[t].some(step => builder[step])).map(t => `${p.name} on a ${t}`);
        });
        expect(missing).toEqual([]);
    });

    it("are only for profiles in the catalog", () => {
        expect(Object.keys(BUILDERS).filter(name => !catalog!.profiles[name])).toEqual([]);
    });

    it("leave the chart-only profiles to the generic builder", () => {
        const generic = Object.values(catalog!.profiles).filter(p => p.chart && !BUILDERS[p.name as keyof typeof BUILDERS]).map(p => p.name).sort();
        expect(generic).toEqual(["ai-factory", "cert-manager", "harvester-dns-controller", "hauler-chart", "metallb", "open-webui", "opentelemetry", "outrider", "sprouter", "traefik", "vllm"]);
        // And the ResourceProfiles: objects only.
        expect(Object.values(catalog!.profiles).filter(p => p.kind === "resource").map(p => p.name).sort()).toEqual(["ai-demos"]);
    });
});
