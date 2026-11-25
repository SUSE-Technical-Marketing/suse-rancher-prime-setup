// The seam between what a lab says and where it runs (DESIGN.md §18).
//
// A **host backend** makes one kind of host: given a resolved host it returns where to reach it and
// what its setup has to wait for. A **site backend** knows what a site holds for a lab, so `destroy
// --check` can say what is left. Both are registries keyed by kind and typed over every kind, so
// adding a backend (libvirt, EC2, Hetzner) does not compile until it is handled everywhere, and
// nothing outside a backend compares kinds to decide how a host is made.

import type * as pulumi from "@pulumi/pulumi";
import { sitesOf, type HostKind, type ResolvedHost, type ResolvedLab, type SiteKind } from "@lab/schema";

// --- Hosts ----------------------------------------------------------------------------------

/** What provisioning a host gives the rest of the program. */
export interface ProvisionedHost {
    /** Where the host is reached: a VM's address once it has one, an existing machine's own. */
    address: pulumi.Output<string>;
    /** What its setup waits for: the VM, once created. Nothing for a machine that already runs. */
    ready: pulumi.Resource[];
    /**
     * The VM resource. What is installed on the host is `deletedWith` it, so deleting the VM removes
     * it all at once. Undefined for a machine that stays: its things are removed one by one.
     */
    machine?: pulumi.Resource;
    /** The site resources the host's profiles wait on (a Harvester's base), when it lives on one. */
    site?: { name: string; ready: pulumi.Resource[] };
}

/** Makes the hosts of one kind. `Ctx` is what the program gives every backend (the lab, its sites' resources). */
export interface HostBackend<K extends HostKind, Ctx> {
    readonly kind: K;
    provision(host: Extract<ResolvedHost, { kind: K }>, ctx: Ctx): ProvisionedHost;
}

/** A backend for every host kind. */
export type HostBackends<Ctx> = { [K in HostKind]: HostBackend<K, Ctx> };

/** Provision a host with the backend of its kind. */
export function provisionHost<Ctx>(backends: HostBackends<Ctx>, host: ResolvedHost, ctx: Ctx): ProvisionedHost {
    const backend = backends[host.kind] as HostBackend<HostKind, Ctx> | undefined;
    if (!backend) throw new Error(`no backend for host kind "${host.kind}" (host ${host.name})`);
    if (backend.kind !== host.kind) throw new Error(`the host backend registered for "${host.kind}" says it is for "${backend.kind}"`);
    return backend.provision(host as never, ctx);
}

// --- Sites ------------------------------------------------------------------------------------

/** What is still on a site for a lab. */
export interface Leftovers {
    /** Still present and not being deleted: a teardown leak. */
    found: string[];
    /** Already being deleted (pods shutting down, finalizers running): give it a moment. */
    terminating: string[];
}

/** Knows a kind of site. `Ctx` is what the CLI has for reaching them (logins, keys). */
export interface SiteBackend<Ctx> {
    readonly kind: SiteKind;
    /** Everything of the lab left on the lab's sites of this kind, found by the lab's name; destroys nothing. */
    leftovers(lab: ResolvedLab, ctx: Ctx): Promise<Leftovers>;
}

/** A backend for every site kind. */
export type SiteBackends<Ctx> = { [K in SiteKind]: SiteBackend<Ctx> };

/** The leftovers on every site kind the lab uses, and where it looked. Kinds the lab has no site of are skipped. */
export async function findLeftovers<Ctx>(backends: SiteBackends<Ctx>, lab: ResolvedLab, ctx: Ctx): Promise<Leftovers & { checked: SiteKind[] }> {
    const used = new Set(sitesOf(lab).map(s => s.kind));
    const result: Leftovers & { checked: SiteKind[] } = { found: [], terminating: [], checked: [] };
    for (const [kind, backend] of Object.entries(backends) as [SiteKind, SiteBackend<Ctx>][]) {
        if (backend.kind !== kind) throw new Error(`the site backend registered for "${kind}" says it is for "${backend.kind}"`);
        if (!used.has(kind)) continue;
        const left = await backend.leftovers(lab, ctx);
        result.found.push(...left.found);
        result.terminating.push(...left.terminating);
        result.checked.push(kind);
    }
    return result;
}
