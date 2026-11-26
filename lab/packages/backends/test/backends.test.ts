import { describe, expect, it } from "vitest";
import type { ResolvedHost, ResolvedLab } from "@lab/schema";
import { findLeftovers, leftoverExitCode, provisionHost, type HostBackends, type SiteBackends } from "../src";

const harvesterHost = { kind: "harvester", name: "rancher", harvester: "hv" } as ResolvedHost;
const sshHost = { kind: "ssh", name: "nuc", address: "nuc.lab", user: "root" } as ResolvedHost;
const address = (a: string) => a as never;

/** Backends that record what they were asked to provision. */
function hostBackends(calls: string[]): HostBackends<{ tag: string }> {
    return {
        harvester: { kind: "harvester", provision: (h, ctx) => (calls.push(`harvester:${h.name}:${h.harvester}:${ctx.tag}`), { address: address("10.0.0.1"), ready: [] }) },
        ssh: { kind: "ssh", provision: (h, ctx) => (calls.push(`ssh:${h.name}:${h.address}:${ctx.tag}`), { address: address(h.address), ready: [] }) },
    };
}

describe("provisionHost", () => {
    it("asks the backend of the host's kind, with the host narrowed to it and the program's context", () => {
        const calls: string[] = [];
        const backends = hostBackends(calls);
        provisionHost(backends, harvesterHost, { tag: "c" });
        provisionHost(backends, sshHost, { tag: "c" });
        expect(calls).toEqual(["harvester:rancher:hv:c", "ssh:nuc:nuc.lab:c"]);
    });

    it("returns what the backend provisioned", () => {
        expect(provisionHost(hostBackends([]), sshHost, { tag: "c" }).address).toBe("nuc.lab");
    });

    it("refuses a backend registered under another kind's name", () => {
        const backends = hostBackends([]);
        const swapped = { ...backends, harvester: backends.ssh } as unknown as HostBackends<{ tag: string }>;
        expect(() => provisionHost(swapped, harvesterHost, { tag: "c" })).toThrow(/registered for "harvester" says it is for "ssh"/);
    });

    it("says which kind has no backend", () => {
        const none = {} as HostBackends<{ tag: string }>;
        expect(() => provisionHost(none, sshHost, { tag: "c" })).toThrow(/no backend for host kind "ssh" \(host nuc\)/);
    });
});

const lab = (harvesters: string[], awsSites: string[]) => ({
    name: "demo", harvesters: harvesters.map(name => ({ name })), awsSites: awsSites.map(name => ({ name })),
}) as unknown as ResolvedLab;

function siteBackends(asked: string[], left: { harvester?: string[]; aws?: string[]; dying?: string[]; unknown?: string[] } = {}): SiteBackends<undefined> {
    return {
        harvester: { kind: "harvester", leftovers: async () => (asked.push("harvester"), { found: left.harvester ?? [], terminating: left.dying ?? [], unknown: left.unknown ?? [] }) },
        aws: { kind: "aws", leftovers: async () => (asked.push("aws"), { found: left.aws ?? [], terminating: [], unknown: [] }) },
    };
}

describe("findLeftovers", () => {
    it("asks every kind of site the lab uses and merges the answers", async () => {
        const asked: string[] = [];
        const result = await findLeftovers(siteBackends(asked, { harvester: ["volumes"], aws: ["VPCs"], dying: ["pods"] }), lab(["hv"], ["aws-eu"]), undefined);
        expect(asked).toEqual(["harvester", "aws"]);
        expect(result).toEqual({ found: ["volumes", "VPCs"], terminating: ["pods"], unknown: [], checked: ["harvester", "aws"] });
    });

    it("skips a kind the lab has no site of", async () => {
        const asked: string[] = [];
        const result = await findLeftovers(siteBackends(asked), lab(["hv"], []), undefined);
        expect(asked).toEqual(["harvester"]);
        expect(result.checked).toEqual(["harvester"]);
    });

    it("asks nobody for a lab with no sites", async () => {
        const asked: string[] = [];
        expect(await findLeftovers(siteBackends(asked), lab([], []), undefined)).toEqual({ found: [], terminating: [], unknown: [], checked: [] });
        expect(asked).toEqual([]);
    });

    it("keeps what couldn't be checked apart from what was found", async () => {
        const result = await findLeftovers(siteBackends([], { unknown: ["hv: couldn't check images (HTTP 403)"] }), lab(["hv"], []), undefined);
        expect(result.found).toEqual([]);
        expect(result.unknown).toEqual(["hv: couldn't check images (HTTP 403)"]);
    });

    it("refuses a backend registered under another kind's name", async () => {
        const backends = siteBackends([]);
        const swapped = { ...backends, harvester: backends.aws } as SiteBackends<undefined>;
        await expect(findLeftovers(swapped, lab(["hv"], []), undefined)).rejects.toThrow(/registered for "harvester" says it is for "aws"/);
    });
});

describe("leftoverExitCode", () => {
    const left = (found: string[], unknown: string[] = [], terminating: string[] = []) => ({ found, unknown, terminating });

    it("is 0 for a clean lab, also while things are still shutting down", () => {
        expect(leftoverExitCode(left([]))).toBe(0);
        expect(leftoverExitCode(left([], [], ["pods"]))).toBe(0);
    });

    it("is 1 when something is left, even when other checks couldn't run", () => {
        expect(leftoverExitCode(left(["volumes"]))).toBe(1);
        expect(leftoverExitCode(left(["volumes"], ["images (HTTP 403)"]))).toBe(1);
    });

    it("is 3 when nothing was found but a check couldn't run: not known to be clean", () => {
        expect(leftoverExitCode(left([], ["images (HTTP 403)"]))).toBe(3);
    });
});
