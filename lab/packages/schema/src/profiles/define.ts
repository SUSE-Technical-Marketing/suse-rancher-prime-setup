import { z } from "zod";
import { OsFamily } from "../primitives";

/**
 * The rules a profile places on the host it runs on and on the rest of the lab. They're data, so
 * the resolver can check them and the program can order builds without knowing any profile.
 *
 * A *capability* is a name for something a host offers. Every profile provides its own name;
 * `provides` adds more (k3s and rke2 both provide `kubernetes`).
 */
export interface ProfileRules {
    /** Extra capabilities this profile gives its host. */
    provides?: string[];
    /**
     * Capabilities that other profiles on the same host must provide. Each entry is one
     * requirement; the profiles providing it are built first.
     */
    requires?: string[];
    /**
     * Like `requires`, but only when a settings field (dot path) is set: a non-empty value, list or
     * map. For example Rancher needs `downstream-secrets` only when `fleet.secrets` is configured.
     */
    requiresWhen?: { field: string; capability: string }[];
    /**
     * Capabilities this profile uses when the host has them, without requiring them: their
     * providers are built first. Traefik uses `load-balancer` to annotate its Service.
     */
    uses?: string[];
    /** Capabilities no other profile on the same host may provide. */
    conflicts?: string[];
    /** The host's OS must belong to one of these families. */
    osFamilies?: OsFamily[];
    /** Kinds of host the profile can run on (`harvester` VMs, existing `ssh` machines). */
    hostKinds?: ("harvester" | "ssh")[];
    /** Features the host's network must have configured on its Harvester (`dhcp`, `loadBalancer`). */
    networkFeatures?: ("dhcp" | "loadBalancer")[];
    /** Settings fields that name another host in the lab, and what that host must provide. */
    hostRefs?: { field: string; provides: string }[];
    /**
     * Settings fields (dot paths) holding secrets. Written as plain text in a lab file, they cause a
     * warning. A field holding a username + password says `shape: "credentials"`.
     */
    secretFields?: (string | { field: string; shape: "string" | "credentials" })[];
}

export interface ProfileDefinition<N extends string = string, S extends z.ZodType = z.ZodType> extends ProfileRules {
    name: N;
    /** One line for `lab plan` and the docs. */
    description: string;
    /** The profile's settings as written under `profiles.<name>` in a lab file. */
    settings: S;
}

export function defineProfile<const N extends string, S extends z.ZodType>(def: ProfileDefinition<N, S>): ProfileDefinition<N, S> {
    return def;
}
