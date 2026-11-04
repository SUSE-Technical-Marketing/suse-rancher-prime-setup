import { z } from "zod";
import { CLUSTER_TYPE_NAMES } from "../clusters/names";
import { LAB_FEATURES, OS_FAMILIES, OS_FEATURES, TIMEOUTS } from "../primitives";
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
    /**
     * Values for some targets only: each overlay whose `when` (a template rendering to true or
     * false, on `target.kind`, `target.capabilities`, settings) is true merges its `values` and
     * `lockedValues` over the entry's, in order. Its locked paths are protected as the entry's.
     */
    valueOverlays: z.array(z.strictObject({
        when: z.string().min(1),
        values: z.record(z.string(), z.unknown()).optional(),
        lockedValues: z.record(z.string(), z.unknown()).optional(),
    })).optional(),
    /** A template that must render to true or false: the entry is only installed when true. */
    when: z.string().min(1).optional(),
    /**
     * What must exist on the cluster before it's installed, by API path (a template), optionally with
     * a condition True: what something else puts there (Fleet's cert-manager, by its CRD).
     */
    waitFor: z.array(z.strictObject({ path: z.string().min(1), condition: z.string().min(1).optional() })).optional(),
    /** Another version than the catalog's (a template; empty means the catalog's). */
    version: z.string().optional(),
    /** A manifest's URL placeholders besides `{version}`, e.g. `{channel}`. */
    vars: z.record(z.string(), z.string()).optional(),
});
export type ProfileChartEntry = z.infer<typeof ProfileChartEntry>;

/**
 * A Kubernetes object a profile creates on its host's cluster, after its charts (DESIGN.md §17):
 * strings in it are templates as in chart values, secrets too. Created in order, each after the one
 * before; the last is what the profile's capabilities wait for.
 */
export const ProfileObjectEntry = z.strictObject({
    /** Its name in the lab's state, under the profile (a template): keep it, or a running lab replaces the object. */
    name: z.string().min(1),
    object: z.record(z.string(), z.unknown()),
    /** A template that must render to true or false: the object is only created when true. */
    when: z.string().min(1).optional(),
    /**
     * First wait until the cluster's API server admits it (a dry run): a chart's webhook (MetalLB's)
     * can report Ready before the API server reaches it, and the create would fail.
     */
    admitted: z.boolean().optional(),
    /**
     * Its names in the lab's state before, whole (templates: `{{ target.name }}/dns-controller-secret`,
     * from when the profile had code): a running lab keeps the object instead of replacing it.
     */
    aliases: z.array(z.string().min(1)).optional(),
    /** Wait until the object has this condition True (`Ready`), up to one of the lab's timeouts. */
    wait: z.strictObject({ condition: z.string().min(1), timeout: z.enum(TIMEOUTS).default("resourceReady") }).optional(),
    /**
     * Parts for some targets only, as a chart entry's `valueOverlays`: each overlay whose `when` (a
     * template rendering to true or false) is true merges its `object` into the object, in order:
     * maps key by key, anything else (lists too) replaced.
     */
    objectOverlays: z.array(z.strictObject({ when: z.string().min(1), object: z.record(z.string(), z.unknown()) })).optional(),
});
export type ProfileObjectEntry = z.infer<typeof ProfileObjectEntry>;

export const ProfileInput = z.strictObject({
    /**
     * `planned`: in the catalog with its rules and settings, but the engine doesn't build it yet. A
     * lab using it validates with a warning (a design for later), and `lab up` refuses it.
     */
    status: z.enum(["ready", "planned"]).optional(),
    /** Its icon in the lab UI: a Lucide icon name (https://lucide.dev/icons), e.g. `tractor`. */
    icon: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a Lucide icon name like server-cog").optional(),
    /**
     * What it installs, in order, each after the one before is ready. The first chart is the
     * profile's own: the lab's `values` and the profile's `version` setting apply to it.
     */
    charts: z.array(ProfileChartEntry).optional(),
    /** Objects it creates after its charts (an issuer, a certificate, an address pool). */
    objects: z.array(ProfileObjectEntry).optional(),
    /**
     * What its own chart's resource was created as before, from when the profile had code of its own:
     * a component type (`lab:apps:CertManager`), or a type and a whole name (a template:
     * `{{ target.name }}/dns-controller`). A running lab keeps it instead of replacing it.
     */
    aliases: z.array(z.union([z.string().min(1), z.strictObject({ type: z.string().min(1).optional(), name: z.string().min(1).optional() })])).optional(),
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
    /** A capability required when a setting is set, or (`equals`) has that value. */
    requiresWhen: z.array(z.strictObject({ field: z.string().min(1), equals: z.union([z.string(), z.number(), z.boolean()]).optional(), capability: z.string().min(1) })).optional(),
    /** Capabilities used when the host has them, without requiring them: their providers are built first. */
    uses: z.array(z.string().min(1)).optional(),
    /** Capabilities no other profile on the same host may provide. */
    conflicts: z.array(z.string().min(1)).optional(),
    /** The host's OS must belong to one of these families. */
    osFamilies: z.array(z.enum(OS_FAMILIES)).optional(),
    /** What it needs of the lab itself: `acme`, an ACME server to issue certificates from. */
    labRequires: z.array(z.enum(LAB_FEATURES)).optional(),
    /**
     * Sections every node it's on needs in its OS profile: `landlock` (how the OS turns Landlock on).
     * On a host, the host's OS; on a cluster, its machines' or nodes' OS.
     */
    osFeatures: z.array(z.enum(OS_FEATURES)).optional(),
    /** Downstream cluster types it can't go on, and why (a k3k cluster runs on its parent's nodes). */
    notOnClusterTypes: z.partialRecord(z.enum(CLUSTER_TYPE_NAMES), z.string().min(1)).optional(),
    /** Kinds of host the profile can run on (`harvester` VMs, existing `ssh` machines). */
    hostKinds: z.array(z.enum(["harvester", "ssh"])).optional(),
    /** Features the host's network must have configured on its Harvester. */
    networkFeatures: z.array(z.enum(["dhcp", "loadBalancer"])).optional(),
    /**
     * Where it goes: lab `host`s, downstream `cluster`s and `harvester`s (the HCI cluster itself, a
     * ChartProfile as an add-on). Default: a Profile hosts only, a ChartProfile hosts and clusters.
     */
    targets: z.array(z.enum(["host", "cluster", "harvester"])).optional(),
    /**
     * Settings fields that name a downstream cluster in the lab, and what its Fleet profiles must
     * provide (`observer`, naming a cluster with SUSE Observability).
     */
    clusterRefs: z.array(z.strictObject({ field: z.string().min(1), provides: z.string().min(1) })).optional(),
    /**
     * StackPacks the SUSE Observability instance it sends to gets (DESIGN.md §9.6): on the cluster
     * its `on` clusterRefs field names, installed with `adminToken` (a template: a secret setting),
     * once per instance, while any profile in the lab wants them; uninstalled after the last.
     */
    observerStackPacks: z.strictObject({
        on: z.string().min(1),
        adminToken: z.string().min(1),
        install: z.array(z.string().min(1)).min(1),
    }).optional(),
    /** Settings fields that name another host in the lab, and what that host must provide. */
    hostRefs: z.array(z.strictObject({ field: z.string().min(1), provides: z.string().min(1) })).optional(),
    /**
     * What other profiles on the host can use in their templates, by capability this profile
     * provides: `outputs: { tls: { secretName: wildcard-cert } }` is `{{ outputs.tls.secretName }}`.
     */
    outputs: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
    /**
     * The settings under `profiles.<name>`: a JSON Schema object (subset, with the lab's types: see
     * settings-schema.ts). Settings typed `secret` or `credentials` hold secrets: written as plain
     * text in a lab file they cause a warning.
     */
    settings: z.custom<SettingSchema>(v => typeof v === "object" && v !== null && !Array.isArray(v), "must be a JSON Schema object").optional(),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

export interface ProfileDefinition extends Omit<ProfileInput, "settings"> {
    /** `custom`: a Profile, with a builder in the engine, for lab hosts; `chart`: a ChartProfile, for hosts and downstream clusters. */
    kind: "custom" | "chart";
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

/** Where a profile can go: a Profile's `targets` (default lab hosts), a ChartProfile hosts and clusters. */
export const profileTargets = (def: Pick<ProfileDefinition, "kind" | "targets">): ("host" | "cluster" | "harvester")[] =>
    def.targets ?? (def.kind === "chart" ? ["host", "cluster"] : ["host"]);

/** All profiles, by name: built from the catalog, passed to the rule checks. */
export type ProfileRegistry = Record<string, ProfileDefinition>;
