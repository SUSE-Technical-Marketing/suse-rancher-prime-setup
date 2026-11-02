import { beforeEach, describe, expect, it, vi } from "vitest";
import { addonProvider } from "../src/addon";

// The add-on's read and diff against a fake Harvester API.
const live: { status: number; body?: any } = { status: 200 };
// vi.mock is hoisted above the imports: the provider gets the fake.
vi.mock("@lab/kube", () => ({ kubeRequest: vi.fn(async () => live), poll: vi.fn() }));

const props = { harvester: "hv", name: "harvester-dns-controller", namespace: "harvester-system", repo: "", chart: "oci://x/dns", version: "0.4.0", valuesContent: "a: 1\n", timeoutSeconds: 900 };
const spec = { enabled: true, repo: "", chart: "oci://x/dns", version: "0.4.0", valuesContent: "a: 1\n" };
const read = () => addonProvider.read!("hv/harvester-system/harvester-dns-controller", props);
const diff = async (olds: object) => (await addonProvider.diff!("id", olds, props)).changes;

describe("a Harvester add-on, refreshed", () => {
    beforeEach(() => { live.status = 200; live.body = { spec: { ...spec } }; });

    it("is unchanged when the Harvester has it as the lab made it", async () => {
        const r = await read();
        expect(r.id).toBe("hv/harvester-system/harvester-dns-controller");
        expect(await diff(r.props)).toBe(false);
    });

    it("is gone when it was deleted, so it's created again", async () => {
        live.status = 404;
        expect((await read()).id).toBe("");
    });

    it("changes when it was disabled or its values edited, so the next update puts the lab's back", async () => {
        live.body = { spec: { ...spec, enabled: false } };
        expect(await diff((await read()).props)).toBe(true);
        live.body = { spec: { ...spec, valuesContent: "a: 2\n" } };
        expect(await diff((await read()).props)).toBe(true);
    });

    it("is left as it is when it's someone else's", async () => {
        live.body = { spec: { ...spec, version: "9.9.9", enabled: false } };
        const r = await addonProvider.read!("id", { ...props, adopted: true });
        expect(r.props).toEqual({ ...props, adopted: true });
    });
});
