import { describe, expect, it } from "vitest";
import { findLeftovers } from "@lab/backends";
import { HarvesterApi } from "@lab/core";
import { SITE_TRAITS, type ResolvedHarvester, type ResolvedLab } from "@lab/schema";
import { checkOwnership, claimHarvesters, currentUser, releaseHarvesters, type HarvesterSession } from "../src/harvesters";
import { siteBackends } from "../src/sites";

/** A Harvester's Kubernetes API in memory: objects by path, ConfigMap creation like the real one (409 if it exists). */
class FakeHarvester {
    objects = new Map<string, any>();
    calls: string[] = [];
    async k8s(method: string, path: string, body?: any) {
        this.calls.push(`${method} ${path}`);
        if (method === "GET") {
            const hit = this.objects.get(path);
            return hit ? { status: 200, body: hit } : { status: 404, body: undefined };
        }
        if (method === "POST") {
            const key = `${path}/${body.metadata.name}`;
            if (this.objects.has(key)) return { status: 409, body: undefined };
            this.objects.set(key, body);
            return { status: 201, body };
        }
        if (method === "DELETE") {
            this.objects.delete(path);
            return { status: 200, body: undefined };
        }
        throw new Error(`unexpected ${method} ${path}`);
    }
}

const CLAIM = "/api/v1/namespaces/default/configmaps/lab-owner";
const harvester = (name: string) => ({
    name, storageClass: { name: "lab-sc" },
}) as unknown as ResolvedHarvester;
const lab = (name: string, harvesters: string[] = ["hv"], awsSites: string[] = []) =>
    ({ name, harvesters: harvesters.map(harvester), awsSites: awsSites.map(n => ({ name: n, region: "eu-west-1" })), downstream: [], hosts: [] }) as unknown as ResolvedLab;
const session = (fake: FakeHarvester, name = "hv"): HarvesterSession => ({ harvester: harvester(name), api: fake as unknown as HarvesterApi });
const claimedBy = (lab: string, user: string) => ({ metadata: { name: "lab-owner" }, data: { lab, user, claimedAt: "2026-10-01T10:00:00.000Z" } });

describe("site backends", () => {
    it("has one for every kind of site, registered under its own kind", () => {
        expect(Object.keys(siteBackends).sort()).toEqual(Object.keys(SITE_TRAITS).sort());
        for (const [kind, backend] of Object.entries(siteBackends)) expect(backend.kind).toBe(kind);
    });

    it("reports what a lab left on a Harvester, by the lab's name", async () => {
        const fake = new FakeHarvester();
        fake.objects.set("/api/v1/namespaces/demo", { metadata: { name: "demo" } });
        const result = await findLeftovers(siteBackends, lab("demo"), { sessions: [session(fake)], aws: [] });
        expect(result.found).toEqual(["hv: namespace demo"]);
        expect(result.checked).toEqual(["harvester"]);
    });

    it("reports nothing for a clean Harvester, and separates what is still shutting down", async () => {
        const clean = new FakeHarvester();
        expect(await findLeftovers(siteBackends, lab("demo"), { sessions: [session(clean)], aws: [] })).toEqual({ found: [], terminating: [], checked: ["harvester"] });

        const dying = new FakeHarvester();
        dying.objects.set("/api/v1/namespaces/demo", { metadata: { name: "demo", deletionTimestamp: "2026-10-01T10:00:00Z" } });
        const result = await findLeftovers(siteBackends, lab("demo"), { sessions: [session(dying)], aws: [] });
        expect(result.found).toEqual([]);
        expect(result.terminating).toEqual(["hv: namespace demo"]);
    });

    it("doesn't touch a kind of site the lab has none of", async () => {
        const fake = new FakeHarvester();
        // No AWS site and no keys: asking AWS would fail; the lab has none, so nobody asks.
        const result = await findLeftovers(siteBackends, lab("demo", ["hv"], []), { sessions: [session(fake)], aws: [] });
        expect(result.checked).not.toContain("aws");
    });
});

describe("a Harvester's claim", () => {
    const me = () => currentUser();

    it("is made for the lab, and made again without complaint", async () => {
        const fake = new FakeHarvester();
        await claimHarvesters(lab("demo"), [session(fake)]);
        expect(fake.objects.get(CLAIM)).toMatchObject({ data: { lab: "demo", user: me() } });
        await expect(claimHarvesters(lab("demo"), [session(fake)])).resolves.toBeUndefined();
    });

    it("is refused while another lab has the Harvester, naming that lab (a Harvester is exclusive)", async () => {
        expect(SITE_TRAITS.harvester.sharing).toBe("exclusive");
        const fake = new FakeHarvester();
        fake.objects.set(CLAIM, claimedBy("mlm", "someone@example.com"));
        await expect(checkOwnership(lab("demo"), [session(fake)])).rejects.toThrow(/in use by lab "mlm" \(someone@example.com, since 2026-10-01/);
        await expect(claimHarvesters(lab("demo"), [session(fake)])).rejects.toThrow(/in use by lab "mlm"/);
    });

    it("checking changes nothing", async () => {
        const fake = new FakeHarvester();
        await checkOwnership(lab("demo"), [session(fake)]);
        expect(fake.calls.every(c => c.startsWith("GET"))).toBe(true);
        expect(fake.objects.size).toBe(0);
    });

    it("is released by its owner, and left alone by anyone else unless forced", async () => {
        const fake = new FakeHarvester();
        await claimHarvesters(lab("demo"), [session(fake)]);
        await releaseHarvesters(lab("demo"), [session(fake)]);
        expect(fake.objects.size).toBe(0);

        fake.objects.set(CLAIM, claimedBy("mlm", "someone@example.com"));
        await expect(releaseHarvesters(lab("demo"), [session(fake)])).rejects.toThrow(/in use by lab "mlm"/);
        await releaseHarvesters(lab("demo"), [session(fake)], true);
        expect(fake.objects.size).toBe(0);
    });

    it("is made on every Harvester of the lab", async () => {
        const a = new FakeHarvester();
        const b = new FakeHarvester();
        await claimHarvesters(lab("demo", ["a", "b"]), [session(a, "a"), session(b, "b")]);
        expect(a.objects.size).toBe(1);
        expect(b.objects.size).toBe(1);
    });
});
