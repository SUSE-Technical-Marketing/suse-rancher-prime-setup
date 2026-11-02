import type { EngineEvent } from "@pulumi/pulumi/automation";

// A Harvester VM's cloud-init (user data and network config) is a Secret it reads on first boot
// only. When the Secret changes but the VM stays, the running VM keeps its old setup: new profiles
// aren't installed, a new address isn't set. The engine doesn't recreate the VM for it; the CLI
// says so instead.

const SECRET = "kubernetes:core/v1:Secret";
const VM = "kubernetes:kubevirt.io/v1:VirtualMachine";
const CHANGED = new Set(["update", "replace"]);
const RECREATED = new Set(["create", "replace", "create-replacement"]);

/** Collects, from a preview's or an update's engine events, the VMs whose cloud-init changed while the VM itself stays. */
export class CloudInitWatch {
    private readonly changed = new Set<string>();
    private readonly recreated = new Set<string>();

    readonly onEvent = (event: EngineEvent): void => {
        const step = event.resourcePreEvent?.metadata;
        if (!step) return;
        const name = step.urn.slice(step.urn.lastIndexOf("::") + 2);
        if (step.type === SECRET && name.endsWith("/cloudinit") && CHANGED.has(step.op)) this.changed.add(name.slice(0, -"/cloudinit".length));
        if (step.type === VM && name.endsWith("/vm") && RECREATED.has(step.op)) this.recreated.add(name.slice(0, -"/vm".length));
    };

    /** The hosts whose running VM won't see their new cloud-init, sorted. */
    stale(): string[] {
        return [...this.changed].filter(h => !this.recreated.has(h)).sort();
    }

    warnings(labFile: string): string[] {
        return this.stale().map(h =>
            `host ${h}: its cloud-init (user data or network config) changes, but its VM stays and only reads cloud-init on first boot, ` +
            `so the running VM keeps its old setup and steps that need the new one may fail or hang. ` +
            `To apply it, recreate the lab: "lab destroy ${labFile}", then "lab up ${labFile}".`);
    }
}
