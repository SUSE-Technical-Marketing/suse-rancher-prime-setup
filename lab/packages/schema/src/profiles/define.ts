import { z } from "zod";
import { OS_FAMILIES } from "../primitives";
import { SettingSchema } from "../settings-schema";

/**
 * The rules a profile places on the host it runs on and on the rest of the lab, as written in its
 * Profile document in the catalog (DESIGN.md §16.10, §17). They're data, so the
 * resolver can check them and the program can order builds without knowing any profile.
 *
 * A *capability* is a name for something a host offers. Every profile provides its own name;
 * `provides` adds more (k3s and rke2 both provide `kubernetes`).
 */
/**
 * One thing a profile installs, in order (DESIGN.md §17): a HelmChart or a Manifest from the catalog.
 * String values, `when`, `version` and `vars` may be Jinja2 templates, rendered per host.
 */
export const ProfileChartEntry = z.strictObject({
    chart: z.string().min(1).optional(),
    manifest: z.string().min(1).optional(),
    /** A chart's namespace (required for charts). */
    namespace: z.string().min(1).optional(),
    /** A chart's default values; for the first chart, the lab's `values` merge over them. */
    values: z.record(z.string(), z.unknown()).optional(),
    /** A chart's values merged last; for the first chart, a lab can't set them. */
    lockedValues: z.record(z.string(), z.unknown()).optional(),
    /** A template that must render to true or false: the entry is only installed when true. */
    when: z.string().min(1).optional(),
    /** Another version than the catalog's (a template; empty means the catalog's). */
    version: z.string().optional(),
    /** A manifest's URL placeholders besides `{version}`, e.g. `{channel}`. */
    vars: z.record(z.string(), z.string()).optional(),
});
export type ProfileChartEntry = z.infer<typeof ProfileChartEntry>;

export const ProfileInput = z.strictObject({
    /** Its icon in the lab UI: a Lucide icon name (https://lucide.dev/icons), e.g. `tractor`. */
    icon: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a Lucide icon name like server-cog").optional(),
    /**
     * What it installs, in order, each after the one before is ready. The first chart is the
     * profile's own: the lab's `values` and the profile's `version` setting apply to it.
     */
    charts: z.array(ProfileChartEntry).optional(),
    /** The KubernetesDistribution it installs (k3s, RKE2). */
    distribution: z.string().min(1).optional(),
    /** Extra capabilities this profile gives its host. */
    provides: z.array(z.string().min(1)).optional(),
    /**
     * Capabilities it provides itself only when no other profile on the host does: k3s's and RKE2's
     * own ServiceLB (`load-balancer`) and Traefik (`ingress`). Another provider turns them off.
     */
    fallback: z.array(z.string().min(1)).optional(),
    /** Capabilities other profiles on the same host must provide; their providers are built first. */
    requires: z.array(z.string().min(1)).optional(),
    /** Like `requires`, but only when a settings field (dot path) is set: a non-empty value, list or map. */
    requiresWhen: z.array(z.strictObject({ field: z.string().min(1), capability: z.string().min(1) })).optional(),
    /** Capabilities used when the host has them, without requiring them: their providers are built first. */
    uses: z.array(z.string().min(1)).optional(),
    /** Capabilities no other profile on the same host may provide. */
    conflicts: z.array(z.string().min(1)).optional(),
    /** The host's OS must belong to one of these families. */
    osFamilies: z.array(z.enum(OS_FAMILIES)).optional(),
    /** Kinds of host the profile can run on (`harvester` VMs, existing `ssh` machines). */
    hostKinds: z.array(z.enum(["harvester", "ssh"])).optional(),
    /** Features the host's network must have configured on its Harvester. */
    networkFeatures: z.array(z.enum(["dhcp", "loadBalancer"])).optional(),
    /** Settings fields that name another host in the lab, and what that host must provide. */
    hostRefs: z.array(z.strictObject({ field: z.string().min(1), provides: z.string().min(1) })).optional(),
    /**
     * Settings fields (dot paths) holding secrets. Written as plain text in a lab file, they cause a
     * warning. A field holding a username + password says `shape: credentials`.
     */
    secretFields: z.array(z.union([z.string().min(1), z.strictObject({ field: z.string().min(1), shape: z.enum(["string", "credentials"]) })])).optional(),
    /**
     * What other profiles on the host can use in their templates, by capability this profile
     * provides: `outputs: { tls: { secretName: wildcard-cert } }` is `{{ outputs.tls.secretName }}`.
     */
    outputs: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
    /** The settings under `profiles.<name>`: a JSON Schema object (subset, see settings-schema.ts). */
    settings: z.custom<SettingSchema>(v => typeof v === "object" && v !== null && !Array.isArray(v), "must be a JSON Schema object").optional(),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

export interface ProfileDefinition extends Omit<ProfileInput, "settings"> {
    /** Its first chart: the one the lab's `values` and the `version` setting apply to. */
    chart?: string;
    /** Value paths a lab's `values` may not touch: the leaves of the first chart's `lockedValues`. */
    protectedValues: string[];
    name: string;
    /** One line for `lab profiles` and the docs (the component's description). */
    description: string;
    /** The settings, as a JSON Schema object (for generated types) and as zod (for checking). */
    settingsSchema: SettingSchema;
    settings: z.ZodType;
    /** The file it comes from. */
    source: string;
}

/** All profiles, by name: built from the catalog, passed to the rule checks. */
export type ProfileRegistry = Record<string, ProfileDefinition>;
