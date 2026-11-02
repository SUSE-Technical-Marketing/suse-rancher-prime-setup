import type { EngineEvent } from "@pulumi/pulumi/automation";
import { describe, expect, it } from "vitest";
import { CloudInitWatch } from "../src/cloudinit";

const URN = "urn:pulumi:probe::lab::lab:harvester:Vm$";
const step = (type: string, name: string, op: string): EngineEvent =>
    ({ sequence: 0, timestamp: 0, resourcePreEvent: { metadata: { op, urn: `${URN}${type}::${name}`, type, provider: "" } } }) as EngineEvent;
const secret = (host: string, op: string) => step("kubernetes:core/v1:Secret", `${host}/cloudinit`, op);
const vm = (host: string, op: string) => step("kubernetes:kubevirt.io/v1:VirtualMachine", `${host}/vm`, op);

const watched = (...events: EngineEvent[]) => {
    const w = new CloudInitWatch();
    for (const e of events) w.onEvent(e);
    return w;
};

describe("cloud-init changes on a running VM", () => {
    it("are reported when the Secret is replaced or updated and the VM stays", () => {
        // As a preview of adding a profile shows it: the Secret replaced (delete-before-replace), the VM the same.
        const w = watched(secret("odin", "delete-replaced"), secret("odin", "replace"), secret("odin", "create-replacement"), vm("odin", "same"), secret("freya", "update"));
        expect(w.stale()).toEqual(["freya", "odin"]);
        expect(w.warnings("labs/x.yaml")[1]).toContain(`"lab destroy labs/x.yaml", then "lab up labs/x.yaml"`);
    });

    it("aren't reported for a new or recreated VM, or an unchanged Secret", () => {
        const w = watched(secret("new", "create"), vm("new", "create"), secret("re", "replace"), vm("re", "replace"), secret("same", "same"));
        expect(w.stale()).toEqual([]);
    });

    it("ignore other Secrets and events", () => {
        const w = watched(step("kubernetes:core/v1:Secret", "odin/rke2/token", "update"), { sequence: 1, timestamp: 0, diagnosticEvent: { message: "x", color: "", severity: "info" } } as EngineEvent);
        expect(w.stale()).toEqual([]);
    });
});
