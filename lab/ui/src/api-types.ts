// The lab UI server's API (server/index.ts): its requests' and answers' types, and nothing else, so
// the server can import them too. The server declares its answers with them, so the two can't drift.

import type { FormMeta } from "../../packages/schema/src/form";

/** A profile's settings: the subset of JSON Schema the catalog uses (packages/schema/src/settings-schema.ts). */
export interface SettingSchema {
    /** JSON Schema's types, or the lab's own: `secret`, `credentials`, `dnsLabel`, `ipv4`, `chartValues`, … */
    type?: string;
    description?: string;
    /** On a `secret` or `credentials` setting: the secret template the composer fills it with, when the personal config has that secret. */
    suggest?: string;
    prefixItems?: SettingSchema[];
    /** How a generated form shows it (a document's schema, packages/schema/src/form.ts). */
    form?: FormMeta;
    const?: string | number | boolean;
    enum?: (string | number | boolean)[];
    pattern?: string;
    anyOf?: SettingSchema[];
    oneOf?: SettingSchema[];
    default?: unknown;
    items?: SettingSchema;
    properties?: Record<string, SettingSchema>;
    required?: string[];
    additionalProperties?: boolean | SettingSchema;
}

/** A Fleet profile: labels and annotations for a downstream cluster, which Fleet installs from. */
export interface FleetProfileInfo {
    name: string;
    description: string;
    icon?: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    requires: string[];
    provides: string[];
    conflicts: string[];
}

/** A StackPack of the catalog, for a cluster running SUSE Observability (its `stackPacks`). */
export interface StackPackInfo {
    name: string;
    description: string;
    /** A Lucide icon name. */
    icon?: string;
    /** Its pinned version; none: the instance's latest. */
    version?: string;
    /** Built from source (`lab stackpacks`), not in the instance's own catalog. */
    fromSource: boolean;
}

export interface CatalogProfile {
    /** `planned`: not built yet; the composer doesn't offer it, `lab up` refuses labs using it. */
    status?: "planned";
    /**
     * `custom`: a Profile, code in the engine, lab hosts only; `chart`: a ChartProfile, hosts and
     * downstream clusters; `resource`: a ResourceProfile, a ChartProfile's objects without a chart.
     */
    kind: "custom" | "chart" | "resource";
    name: string;
    description: string;
    /** A Lucide icon name. */
    icon?: string;
    distribution?: string;
    provides: string[];
    requires: string[];
    conflicts: string[];
    fallback: string[];
    hostKinds?: ("harvester" | "ssh")[];
    osFamilies?: string[];
    /** Where it goes: lab hosts, downstream clusters, Harvesters themselves. */
    targets: ("host" | "cluster" | "harvester")[];
    /** Settings naming a downstream cluster whose Fleet profiles provide something (the agent's `observer`). */
    clusterRefs: { field: string; provides: string }[];
    settings: SettingSchema;
}

export type SecretShape = "string" | "credentials";

/** A personal-config secret, or a field in one: its shape, and a map's field names (never values). */
export interface PersonalSecret {
    /** The path, dotted: `cloudflare.token`. */
    name: string;
    /** The secret's name, then the fields to it. */
    path: string[];
    /** `other`: a value no field can use (a list, a number). */
    shape: SecretShape | "map" | "other";
    fields?: string[];
}

export interface HostRecipe {
    name: string;
    label: string;
    description: string;
    icon?: string;
    kind: "HarvesterVM" | "Machine";
    /** The new host's name, before it's made unique. */
    hostName: string;
    host: { cpu?: number; memory?: string; disk?: string; os?: string; profiles: Record<string, Record<string, unknown>> };
}

export interface Catalog {
    /** `ami`: it can boot EC2 machines. */
    os: { name: string; displayName: string; family: string; image: string; ami: boolean }[];
    profiles: CatalogProfile[];
    fleetProfiles: FleetProfileInfo[];
    acme: string[];
    /** By document kind (Lab, Harvester, AwsSite, HarvesterVM, Machine): its spec's schema, with how its form shows each field. */
    documentForms: Record<string, SettingSchema>;
    /** By downstream cluster type: its schema, with how its form shows each field. */
    clusterForms: Record<string, SettingSchema>;
    /** By downstream cluster type: the capability its Rancher's host must have, and why (`public-ingress` on AWS). */
    rancherNeeds: Record<string, { capability: string; because: string }>;
    /** KubernetesDistributions, for a downstream cluster's `distro`; `default` is the one a cluster gets without one. */
    distributions: { name: string; description?: string; cni: string; default: boolean }[];
    /** The catalog's StackPacks: what a cluster running SUSE Observability can list under stackPacks. */
    stackPacks: StackPackInfo[];
    /** Standard hosts for the palette (HostRecipe documents): what dropping one adds. */
    recipes: HostRecipe[];
    /** HaulManifests, for the hauler profiles' `manifests`. */
    haulManifests: { name: string; description?: string }[];
    fleetRepos: { name: string; description?: string; default: boolean }[];
    /** Inputs of the catalog's secrets and configmaps, by name. */
    inputs: Record<string, SecretShape>;
    defaults: {
        ssh: { user: string };
        vm: { cpu: number; memory: string; disk: string };
        aws: { vpcCidr: string; zones: string[]; instanceType: string; eksVersion: string };
    };
    /** Names only: values never leave the server. */
    personal: { source: string; secrets: PersonalSecret[]; harvesters: string[]; awsSites: { name: string; region?: string }[];
        /** What's wrong with the personal config; when it doesn't load, the catalog is the built-in one alone. */
        problems: string[] };
}

export interface Diagnostic {
    level: "error" | "warning";
    source: string;
    /** `HarvesterVM/odin.spec.os`, or `spec.domain` for the Lab document. */
    path: string;
    message: string;
}

/** What a host's, cluster's or Harvester's profiles provide and still need, as the engine judges them. */
export interface CapabilityReport {
    provided: string[];
    needs: string[];
}

export interface CheckResult {
    ok: boolean;
    diagnostics: Diagnostic[];
    missingSecrets: string[];
    plan?: string;
    /** The Lab document as templates see it (`lab`), its references filled in. */
    lab?: { name?: string; spec?: unknown };
    /** By document (`HarvesterVM/rancher`, `DownstreamCluster/apps`, `Harvester/asgard`): its capabilities. */
    capabilities: Record<string, CapabilityReport>;
}

/** A lab file in the labs directory. */
export interface LabFileEntry { file: string }
export interface LabFileText { file: string; text: string }
