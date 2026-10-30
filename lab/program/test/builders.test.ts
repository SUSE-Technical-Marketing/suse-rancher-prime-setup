import { describe, expect, it } from "vitest";
import { loadCatalog } from "@lab/schema";
import { BUILDERS } from "../profiles";

describe("profile builders", () => {
    const { catalog } = loadCatalog({ personalConfig: "/nonexistent/lab-config.yaml" });

    it("cover every profile: its own builder, or the generic one for a chart-only profile", () => {
        const missing = Object.values(catalog!.profiles).filter(p => !BUILDERS[p.name as keyof typeof BUILDERS] && !p.chart).map(p => p.name);
        expect(missing).toEqual([]);
    });

    it("are only for profiles in the catalog", () => {
        expect(Object.keys(BUILDERS).filter(name => !catalog!.profiles[name])).toEqual([]);
    });

    it("leave the chart-only profiles to the generic builder", () => {
        const generic = Object.values(catalog!.profiles).filter(p => p.chart && !BUILDERS[p.name as keyof typeof BUILDERS]).map(p => p.name).sort();
        expect(generic).toEqual(["ai-factory", "outrider", "sprouter"]);
    });
});
