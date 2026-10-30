import { Diagnostics } from "./diagnostics";
import { OS_FAMILIES, OsFamily, OsProfileInput } from "./schema";

export interface ResolvedOs {
    name: string;
    displayName: string;
    family: OsFamily;
    /** Default public download URL, or null when the image needs an `images:` entry. */
    imageUrl: string | null;
    /**
     * The profile whose image this is: itself, or the nearest one it extends that sets `image`.
     * Harvester images and `images:` entries go by this name, so variants share one download.
     */
    image: string;
    defaultUser?: string;
    /** Its image on AWS: the newest AMI of `owner` matching `name`; `user` is its login. */
    ami?: { owner: string; name: string; user?: string };
    /** For hosts the lab creates. */
    cloudInit: Record<string, unknown>;
    /** Added on Harvester VMs. */
    harvester: Record<string, unknown>;
    /** Added on hosts that run Kubernetes; all an existing machine gets. */
    kubernetes: Record<string, unknown>;
}

/** Where a host's cloud-config goes, which picks the OS profile's sections. */
export interface OsTarget {
    /** A host the lab creates (a VM, a cluster's machine), not an existing machine. */
    created: boolean;
    harvester: boolean;
    kubernetes: boolean;
}

/** The OS profile's cloud-config for a host: the base for one the lab creates, then the Harvester and Kubernetes parts it needs. */
export function osCloudInit(os: ResolvedOs, target: OsTarget): Record<string, unknown> {
    let out: Record<string, unknown> = target.created ? os.cloudInit : {};
    if (target.harvester && target.created) out = extendCloudInit(out, os.harvester);
    if (target.kubernetes) out = extendCloudInit(out, os.kubernetes);
    return out;
}

/** A profile as found in one of the layers, with the file it came from for error messages. */
export interface OsLayerEntry {
    profile: OsProfileInput;
    source: string;
}

/** What an OS profile's `cloudInit` templates can use. */
export interface CloudInitVars {
    /** The lab's secrets, resolved (only the program has them). */
    secrets: Record<string, unknown>;
    lab: { name: string; domain: string; vars: Record<string, unknown> };
}

export const cloudInitVars = (lab: CloudInitVars["lab"], secrets: Record<string, unknown>): CloudInitVars => ({ secrets, lab });

/** cloud-config keys the engine sets: the login, the hostname. */
export const ENGINE_CLOUD_INIT_KEYS = ["users", "user", "system_info", "ssh_authorized_keys", "hostname", "fqdn", "prefer_fqdn_over_hostname", "manage_etc_hosts"];

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A child's cloud-config over its parent's: lists are joined (parent first), maps merged, scalars replaced. */
export function extendCloudInit(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...parent };
    for (const [key, value] of Object.entries(child)) {
        const old = out[key];
        out[key] = Array.isArray(value) && Array.isArray(old) ? [...old, ...value]
            : isMap(value) && isMap(old) ? extendCloudInit(old, value)
            : value;
    }
    return out;
}

/**
 * Merge the OS profile layers (built-in, personal config, lab file; later wins field by field)
 * and resolve `extends`. Every profile is resolved, so mistakes in unused profiles still surface.
 */
export function resolveOsProfiles(layers: Record<string, OsLayerEntry>[], diags: Diagnostics): Record<string, ResolvedOs> {
    const merged: Record<string, OsLayerEntry> = {};
    for (const layer of layers) {
        for (const [name, entry] of Object.entries(layer)) {
            const existing = merged[name];
            merged[name] = existing
                ? { profile: { ...existing.profile, ...entry.profile }, source: entry.source }
                : entry;
        }
    }

    const resolved: Record<string, ResolvedOs> = {};
    type Flat = OsProfileInput & { imageOf: string };
    const flattened: Record<string, Flat | null> = {};

    const flatten = (name: string, chain: string[]): Flat | null => {
        if (name in flattened) return flattened[name];
        const entry = merged[name];
        const { extends: parentName, ...own } = entry.profile;
        let result: Flat | null = { ...own, imageOf: name };
        if (parentName !== undefined) {
            if (chain.includes(parentName)) {
                diags.error(entry.source, `${name}.extends`, `circular extends: ${[...chain, parentName].join(" -> ")}`);
                result = null;
            } else if (!merged[parentName]) {
                diags.error(entry.source, `${name}.extends`, `unknown OS profile "${parentName}"`);
                result = null;
            } else {
                const parent = flatten(parentName, [...chain, parentName]);
                // A profile's own name never carries over to the profiles extending it.
                const { name: _parentName, ...inherited } = parent ?? { imageOf: parentName };
                result = parent ? {
                    ...inherited,
                    ...own,
                    cloudInit: extendCloudInit(inherited.cloudInit ?? {}, own.cloudInit ?? {}),
                    harvester: { cloudInit: extendCloudInit(inherited.harvester?.cloudInit ?? {}, own.harvester?.cloudInit ?? {}) },
                    kubernetes: { cloudInit: extendCloudInit(inherited.kubernetes?.cloudInit ?? {}, own.kubernetes?.cloudInit ?? {}) },
                    imageOf: own.image !== undefined ? name : inherited.imageOf,
                } : null;
            }
        }
        flattened[name] = result;
        return result;
    };

    for (const [name, entry] of Object.entries(merged)) {
        const profile = flatten(name, [name]);
        if (!profile) continue;
        if (profile.name !== undefined && profile.name !== name) {
            diags.error(entry.source, `${name}.name`, `name "${profile.name}" doesn't match the profile key "${name}"`);
            continue;
        }
        if (!profile.family) {
            diags.error(entry.source, `${name}.family`, `missing; must be one of ${OS_FAMILIES.join(", ")}`);
            continue;
        }
        const cloudInit = profile.cloudInit ?? {};
        const harvester = profile.harvester?.cloudInit ?? {};
        const kubernetes = profile.kubernetes?.cloudInit ?? {};
        for (const [section, config] of [["cloudInit", cloudInit], ["harvester.cloudInit", harvester], ["kubernetes.cloudInit", kubernetes]] as const) {
            for (const key of ENGINE_CLOUD_INIT_KEYS.filter(k => k in config)) {
                diags.error(entry.source, `${name}.${section}.${key}`, "set by the engine (the lab's ssh user and the host's name)");
            }
        }
        resolved[name] = {
            name,
            displayName: profile.displayName ?? name,
            family: profile.family,
            imageUrl: profile.image?.url ?? null,
            image: profile.imageOf,
            defaultUser: profile.defaultUser,
            ...(profile.ami ? { ami: profile.ami } : {}),
            cloudInit,
            harvester,
            kubernetes,
        };
    }
    return resolved;
}
