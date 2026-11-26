// What the engine needs to know about a host without knowing which backend made it (DESIGN.md §18).
//
// A resolved host is a `kind`: a VM on a Harvester, an existing machine over SSH, and later a VM on
// libvirt, EC2 or Hetzner. Profiles, `plan`, clusters and the program ask these questions instead of
// comparing kinds, so a new backend adds a row here (the compiler insists) and not a branch in every
// caller.

import type { ResolvedHost } from "./resolve";
import type { SiteRef } from "./sites";

export type HostKind = ResolvedHost["kind"];

export interface HostTraits {
    /** The lab creates the host and `destroy` removes it. An existing machine is neither: it is only set up and, on the way out, uninstalled. */
    created: boolean;
    /**
     * How its OS profile's setup and its profiles' commands reach it: in the user data of a VM
     * (cloud-init, first boot), or over SSH on a machine that already runs.
     */
    bootstrap: "user-data" | "ssh";
}

/** Every host kind's traits. A `Record` over the kinds: a kind added to `ResolvedHost` doesn't compile until it has a row. */
export const HOST_TRAITS: Record<HostKind, HostTraits> = {
    harvester: { created: true, bootstrap: "user-data" },
    ssh: { created: false, bootstrap: "ssh" },
};

export const hostTraits = (host: Pick<ResolvedHost, "kind">): HostTraits => HOST_TRAITS[host.kind];

/** The site a host lives on, if the lab creates it there; an existing machine lives on no site. */
export function hostSite(host: ResolvedHost): SiteRef | undefined {
    switch (host.kind) {
        case "harvester": return { kind: "harvester", name: host.harvester };
        case "ssh": return undefined;
    }
}

/** The user the engine logs in as: the machine's own, or the lab's `ssh.user` on a VM it created. */
export function sshUserOf(host: ResolvedHost, lab: { ssh?: { user: string } }): string {
    return "user" in host ? host.user : lab.ssh!.user;
}
