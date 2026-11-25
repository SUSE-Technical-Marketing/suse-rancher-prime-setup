// Sites: the places a lab's VMs live (DESIGN.md §18). Today a Harvester or an AWS site; libvirt and
// Hetzner join them later. A site is declared by its own document, holds the connection, and hosts
// the VMs (and clusters) of one or more labs.

import type { ResolvedLab } from "./resolve";

export type SiteKind = "harvester" | "aws";

export interface SiteRef {
    kind: SiteKind;
    name: string;
}

export interface SiteTraits {
    /**
     * Whether several labs may use the site at once. `exclusive`: one lab at a time, because the lab
     * changes things that belong to the whole site (a Harvester's add-ons and default storage class).
     * `shared`: everything a lab makes there is its own (a VPC, tagged), so labs don't meet.
     */
    sharing: "exclusive" | "shared";
    /** What the site is called in messages. */
    label: string;
}

/** Every site kind's traits. A `Record`: a kind added to `SiteKind` doesn't compile until it has a row. */
export const SITE_TRAITS: Record<SiteKind, SiteTraits> = {
    harvester: { sharing: "exclusive", label: "Harvester" },
    aws: { sharing: "shared", label: "AWS site" },
};

/** The lab's sites, Harvesters first, each kind in the lab's order. */
export function sitesOf(lab: Pick<ResolvedLab, "harvesters" | "awsSites">): SiteRef[] {
    return [
        ...lab.harvesters.map(h => ({ kind: "harvester" as const, name: h.name })),
        ...lab.awsSites.map(s => ({ kind: "aws" as const, name: s.name })),
    ];
}
