import { Diagnostics } from "./diagnostics";
import { OS_FAMILIES, OsFamily, OsProfileInput, SecretRef } from "./schema";

export interface ResolvedOs {
    name: string;
    displayName: string;
    family: OsFamily;
    /** Default public download URL, or null when the image needs an `images:` entry. */
    imageUrl: string | null;
    defaultUser?: string;
    registration?: { suseconnect?: { regcode: SecretRef | string } };
    repos: { name: string; url: string; gpgkey?: string }[];
    packages: string[];
    k8s: { packages: string[] };
    cloudInit: Record<string, unknown>;
}

/** A profile as found in one of the layers, with the file it came from for error messages. */
export interface OsLayerEntry {
    profile: OsProfileInput;
    source: string;
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
    const flattened: Record<string, OsProfileInput | null> = {};

    const flatten = (name: string, chain: string[]): OsProfileInput | null => {
        if (name in flattened) return flattened[name];
        const entry = merged[name];
        const { extends: parentName, ...own } = entry.profile;
        let result: OsProfileInput | null = own;
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
                const { name: _parentName, ...inherited } = parent ?? {};
                result = parent ? { ...inherited, ...own } : null;
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
        resolved[name] = {
            name,
            displayName: profile.displayName ?? name,
            family: profile.family,
            imageUrl: profile.image?.url ?? null,
            defaultUser: profile.defaultUser,
            registration: profile.registration,
            repos: profile.repos ?? [],
            packages: profile.packages ?? [],
            k8s: { packages: profile.k8s?.packages ?? [] },
            cloudInit: profile.cloudInit ?? {},
        };
    }
    return resolved;
}
