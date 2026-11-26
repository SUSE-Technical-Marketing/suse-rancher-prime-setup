import { describe, expect, it } from "vitest";
import { expiryOf, reapDecision, relative } from "../src/ttl";
import { renderPlan } from "../src/plan";
import type { ResolvedLab } from "@lab/schema";

const T0 = "2026-11-25T10:00:00.000Z";
const at = (iso: string) => new Date(iso);

describe("expiryOf", () => {
    it("counts the ttl from creation", () => {
        const e = expiryOf(T0, 8 * 3600, at("2026-11-25T12:00:00.000Z"));
        expect(e.at?.toISOString()).toBe("2026-11-25T18:00:00.000Z");
        expect(e.expired).toBe(false);
    });

    it("is expired at the moment and after it", () => {
        expect(expiryOf(T0, 3600, at("2026-11-25T11:00:00.000Z")).expired).toBe(true);
        expect(expiryOf(T0, 3600, at("2026-11-25T10:59:59.000Z")).expired).toBe(false);
        expect(expiryOf(T0, 3600, at("2026-12-01T00:00:00.000Z")).expired).toBe(true);
    });

    it("never expires without a ttl or a creation time, or with an unreadable one", () => {
        expect(expiryOf(T0, undefined)).toEqual({ expired: false });
        expect(expiryOf(undefined, 3600)).toEqual({ expired: false });
        expect(expiryOf("not a date", 3600)).toEqual({ expired: false });
    });
});

describe("relative", () => {
    const now = at("2026-11-25T12:00:00.000Z");
    it("says how far away, to the minute", () => {
        expect(relative(at("2026-11-25T15:20:00.000Z"), now)).toBe("in 3h 20m");
        expect(relative(at("2026-11-25T14:00:00.000Z"), now)).toBe("in 2h");
        expect(relative(at("2026-11-25T12:45:00.000Z"), now)).toBe("in 45m");
        expect(relative(at("2026-11-25T10:00:00.000Z"), now)).toBe("2h ago");
    });
});

describe("reapDecision", () => {
    const now = at("2026-11-25T12:00:00.000Z");
    it("destroys only a lab that has a ttl, exists, and is past it", () => {
        expect(reapDecision(3600, true, T0, now)).toBe("expired");
        expect(reapDecision(8 * 3600, true, T0, now)).toBe("alive");
        expect(reapDecision(undefined, true, T0, now)).toBe("no-ttl");
        expect(reapDecision(3600, false, undefined, now)).toBe("no-lab");
    });

    it("keeps a lab whose creation time it can't read", () => {
        expect(reapDecision(3600, true, undefined, now)).toBe("alive");
    });
});

describe("plan", () => {
    const lab = (ttl?: number) => ({ name: "t", domain: "d.example", tls: { acme: "none" }, ...(ttl ? { ttl } : {}), harvesters: [], awsSites: [], hosts: [], downstream: [], os: {}, secrets: {}, objects: [], skippedObjects: [], fleet: {}, stackPacks: [], planned: [] }) as unknown as ResolvedLab;
    it("says when the lab expires, only when it has a ttl", () => {
        expect(renderPlan(lab(8 * 3600), new Set())).toContain('meant to live 8h from its creation; "lab reap" destroys it after that');
        expect(renderPlan(lab(90 * 60), new Set())).toContain("meant to live 90m");
        expect(renderPlan(lab(), new Set())).not.toContain("meant to live");
    });
});
