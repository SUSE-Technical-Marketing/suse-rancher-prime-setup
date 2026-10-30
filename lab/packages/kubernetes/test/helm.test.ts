import { describe, expect, it } from "vitest";
import { deepMerge, mergeValues } from "../src/helm";

describe("chart values", () => {
    it("merge maps key by key and replace lists and scalars", () => {
        expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({ a: { b: 1, c: [3] }, d: 1, e: 2 });
    });

    it("layer profile defaults, computed values, the lab's values, then locked values", () => {
        const defaults = { replicas: 3, global: { psp: false }, logLevel: "info" };
        const computed = { hostname: "rancher.example.com", replicas: 2 };
        const lab = { logLevel: "debug", replicas: 5, extra: true };
        const locked = { replicas: 1 };
        expect(mergeValues(defaults, computed, lab, locked)).toEqual({
            replicas: 1, global: { psp: false }, logLevel: "debug", hostname: "rancher.example.com", extra: true,
        });
    });
});
