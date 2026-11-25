import { describe, expect, it } from "vitest";
import type { ResolvedHost, ResolvedLab } from "@lab/schema";
import { findLeftovers, provisionHost, type HostBackends, type SiteBackends } from "../src";

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

function siteBackends(asked: string[], left: { harvester?: string[]; aws?: string[]; dying?: string[] } = {}): SiteBackends<undefined> {
    return {
        harvester: { kind: "harvester", leftovers: async () => (asked.push("harvester"), { found: left.harvester ?? [], terminating: left.dying ?? [] }) },
        aws: { kind: "aws", leftovers: async () => (asked.push("aws"), { found: left.aws ?? [], terminating: [] }) },
    };
}

describe("findLeftovers", () => {
    it("asks every kind of site the lab uses and merges the answers", async () => {
        const asked: string[] = [];
        const result = await findLeftovers(siteBackends(asked, { harvester: ["volumes"], aws: ["VPCs"], dying: ["pods"] }), lab(["hv"], ["aws-eu"]), undefined);
        expect(asked).toEqual(["harvester", "aws"]);
        expect(result).toEqual({ found: ["volumes", "VPCs"], terminating: ["pods"], checked: ["harvester", "aws"] });
    });

    it("skips a kind the lab has no site of", async () => {
        const asked: string[] = [];
        const result = await findLeftovers(siteBackends(asked), lab(["hv"], []), undefined);
        expect(asked).toEqual(["harvester"]);
        expect(result.checked).toEqual(["harvester"]);
    });

    it("asks nobody for a lab with no sites", async () => {
        const asked: string[] = [];
        expect(await findLeftovers(siteBackends(asked), lab([], []), undefined)).toEqual({ found: [], terminating: [], checked: [] });
        expect(asked).toEqual([]);
    });

    it("refuses a backend registered under another kind's name", async () => {
        const backends = siteBackends([]);
        const swapped = { ...backends, harvester: backends.aws } as SiteBackends<undefined>;
        await expect(findLeftovers(swapped, lab(["hv"], []), undefined)).rejects.toThrow(/registered for "harvester" says it is for "aws"/);
    });
});
