import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStorageClassProvider, defaultStorageClassResetProvider } from "../src/default-class";

const DEFAULT = "storageclass.kubernetes.io/is-default-class";
const CLASSES = "/apis/storage.k8s.io/v1/storageclasses";
const classes = new Map<string, boolean>();
const calls: { method: string; path: string; value?: boolean }[] = [];
let failedClass: string | undefined;
vi.mock("@lab/kube", () => ({
    kubeRequest: vi.fn(async (_target: unknown, method: string, path: string, body?: { metadata: { annotations: Record<string, string> } }) => {
        if (method === "GET") {
            calls.push({ method, path });
            return { status: 200, body: { items: [...classes].map(([name, value]) => ({ metadata: { name, annotations: { [DEFAULT]: String(value) } } })) } };
        }
        const name = path.slice(CLASSES.length + 1);
        const value = body!.metadata.annotations[DEFAULT] === "true";
        calls.push({ method, path, value });
        if (!classes.has(name)) return { status: 404 };
        if (name === failedClass) return { status: 500 };
        if (value && [...classes].some(([other, isDefault]) => other !== name && isDefault)) return { status: 422 };
        classes.set(name, value);
        return { status: 200 };
    }),
}));

const inputs = { harvester: "hv", className: "longhorn-single" };

describe("Harvester's default storage class", () => {
    beforeEach(() => {
        classes.clear();
        classes.set("harvester-longhorn", true);
        calls.length = 0;
        failedClass = undefined;
    });

    it("clears the old default, promotes the new class after creation, and restores on destroy", async () => {
        const reset = await defaultStorageClassResetProvider.create(inputs);
        expect(reset.outs.previous).toEqual(["harvester-longhorn"]);
        expect(classes.get("harvester-longhorn")).toBe(false);
        classes.set(inputs.className, false);
        await defaultStorageClassProvider.create(inputs);
        expect(classes.get(inputs.className)).toBe(true);
        await defaultStorageClassProvider.delete!("id", inputs);
        classes.delete(inputs.className);
        await defaultStorageClassResetProvider.delete!("id", reset.outs);
        expect(classes.get("harvester-longhorn")).toBe(true);
        expect(calls.filter(c => c.method === "PATCH")).toEqual([
            { method: "PATCH", path: `${CLASSES}/harvester-longhorn`, value: false },
            { method: "PATCH", path: `${CLASSES}/longhorn-single`, value: true },
            { method: "PATCH", path: `${CLASSES}/longhorn-single`, value: false },
            { method: "PATCH", path: `${CLASSES}/harvester-longhorn`, value: true },
        ]);
    });

    it("keeps another class's parameters intact and only changes default annotations", async () => {
        classes.set("other", false);
        await defaultStorageClassResetProvider.create(inputs);
        classes.set(inputs.className, false);
        await defaultStorageClassProvider.create(inputs);
        expect(calls.some(c => c.path === `${CLASSES}/other`)).toBe(false);
    });

    it("reports promotion errors rather than pretending the class became default", async () => {
        await defaultStorageClassResetProvider.create(inputs);
        classes.set(inputs.className, false);
        failedClass = inputs.className;
        await expect(defaultStorageClassProvider.create(inputs)).rejects.toThrow("failed: HTTP 500");
        expect(classes.get(inputs.className)).toBe(false);
    });

    it("reports reset errors without continuing to promotion", async () => {
        failedClass = "harvester-longhorn";
        await expect(defaultStorageClassResetProvider.create(inputs)).rejects.toThrow("failed: HTTP 500");
        expect(classes.get("harvester-longhorn")).toBe(true);
    });

    it("allows cleanup when the lab's class or original default is already gone", async () => {
        await defaultStorageClassProvider.delete!("id", inputs);
        classes.clear();
        await defaultStorageClassResetProvider.delete!("id", { ...inputs, previous: ["harvester-longhorn"] });
    });
});
