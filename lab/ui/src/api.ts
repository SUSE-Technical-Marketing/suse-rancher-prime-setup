// The bun server's API (server/index.ts).

/** A profile's settings: the subset of JSON Schema the catalog uses (packages/schema/src/settings-schema.ts). */
export interface SettingSchema {
    type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
    description?: string;
    $ref?: string;
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

export interface CatalogProfile {
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

export interface Catalog {
    /** `ami`: it can boot EC2 machines. */
    os: { name: string; displayName: string; family: string; image: string; ami: boolean }[];
    profiles: CatalogProfile[];
    acme: string[];
    fleetRepos: { name: string; description?: string; default: boolean }[];
    /** Inputs of the catalog's secrets and configmaps, by name. */
    inputs: Record<string, SecretShape>;
    defaults: {
        ssh: { user: string };
        vm: { cpu: number; memory: string; disk: string };
        aws: { vpcCidr: string; zones: string[]; instanceType: string; eksVersion: string };
        [k: string]: unknown;
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

export interface CheckResult {
    ok: boolean;
    diagnostics: Diagnostic[];
    missingSecrets: string[];
    plan?: string;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
    return data as T;
}

export const api = {
    catalog: () => call<Catalog>("GET", "/api/catalog"),
    labs: () => call<{ file: string }[]>("GET", "/api/labs"),
    lab: (file: string) => call<{ file: string; text: string }>("GET", `/api/labs/${encodeURIComponent(file)}`),
    save: (file: string, text: string, overwrite: boolean) => call<{ file: string }>("PUT", `/api/labs/${encodeURIComponent(file)}`, { text, overwrite }),
    check: (text: string, name: string) => call<CheckResult>("POST", "/api/check", { text, name }),
};
