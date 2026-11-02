import { describe, expect, it } from "vitest";
import { loadCatalog, profileTargets } from "@lab/schema";
import { BUILDERS, builderOf } from "../profiles";

describe("profile builders", () => {
    const { catalog } = loadCatalog({ personalConfig: "/nonexistent/lab-config.yaml" });

    it("cover every profile: its own builder, or the generic one for a chart-only profile", () => {
        // Planned profiles aren't built yet: `lab up` refuses labs that use them.
        const missing = Object.values(catalog!.profiles).filter(p => p.status !== "planned" && !BUILDERS[p.name as keyof typeof BUILDERS] && !p.chart).map(p => p.name);
        expect(missing).toEqual([]);
    });

    it("have a step for every target a profile declares", () => {
        // A ChartProfile's generic builder covers hosts and clusters; builderOf needs its chart entry.
        const lab = { profileCharts: Object.fromEntries(Object.values(catalog!.profiles).filter(p => p.chart).map(p => [p.name, {}])) } as never;
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
        expect(generic).toEqual(["ai-factory", "cert-manager", "hauler-chart", "metallb", "outrider", "sprouter", "traefik"]);
    });
});
