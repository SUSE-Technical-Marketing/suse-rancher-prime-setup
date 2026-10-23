import { Credentials, OsFamily, SecretRef } from "../primitives";
import { valuePaths } from "../catalog";
import { ProfileDefinition, ProfileRegistry } from "./define";
import { capabilitiesOf, Profiles, providersOf } from "./index";

/** Value at a dot path (`fleet.secrets.appco`), or undefined. */
export function getPath(obj: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((v, key) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined), obj);
}

/** "Set" for `requiresWhen`: present and, for lists and maps, not empty. */
function isSet(value: unknown): boolean {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
}

/** The capabilities a profile requires with these settings: `requires` plus the `requiresWhen` that apply. */
export function activeRequirements(def: ProfileDefinition, settings: unknown): string[] {
    return [
        ...(def.requires ?? []),
        ...(def.requiresWhen ?? []).filter(r => isSet(getPath(settings, r.field))).map(r => r.capability),
    ];
}

const secretFieldsOf = (def: ProfileDefinition) =>
    (def.secretFields ?? []).map(f => (typeof f === "string" ? { field: f, shape: "string" as const } : f));

/** The profiles set on a host, in a stable order. */
export function activeProfiles(profiles: Profiles): string[] {
    return Object.keys(profiles).filter(n => profiles[n] !== undefined).sort();
}

/** Capability -> the profiles on this host that provide it; a `fallback` only when no other profile does. */
export function hostCapabilities(registry: ProfileRegistry, profiles: Profiles): Map<string, string[]> {
    const caps = new Map<string, string[]>();
    const names = activeProfiles(profiles).filter(n => registry[n]);
    for (const name of names) {
        for (const cap of capabilitiesOf(registry[name])) caps.set(cap, [...(caps.get(cap) ?? []), name]);
    }
    const fallbacks = new Map<string, string[]>();
    for (const name of names) {
        for (const cap of registry[name].fallback ?? []) if (!caps.has(cap)) fallbacks.set(cap, [...(fallbacks.get(cap) ?? []), name]);
    }
    for (const [cap, providers] of fallbacks) caps.set(cap, providers);
    return caps;
}

/** "kubernetes (k3s or rke2)" for a shared capability, just "mlm-server" for a profile's own name. */
export function describeCapability(registry: ProfileRegistry, capability: string): string {
    const providers = providersOf(registry, capability);
    if (providers.length === 1 && providers[0] === capability) return capability;
    return providers.length > 0 ? `${capability} (${providers.join(" or ")})` : capability;
}

export interface HostRulesContext {
    registry: ProfileRegistry;
    host: { name: string; os: string; kind: "harvester" | "ssh"; profiles: Profiles };
    osFamily: OsFamily | undefined;
    /** What the host's network has configured on its Harvester; empty for ssh hosts. */
    networkFeatures: ("dhcp" | "loadBalancer")[];
    /** Other hosts' profiles, for `hostRefs`. */
    profilesOf(host: string): Profiles | undefined;
    error(path: string, message: string): void;
    /** A field listed in `secretFields`: registers the secret(s) or warns about plain values. */
    secretField(value: SecretRef | string | Credentials | undefined, path: string, shape: "string" | "credentials"): void;
    /** Any `{ $secret }` found anywhere in a profile's settings. */
    secretRef(ref: SecretRef, path: string): void;
}

/** Check every profile on a host against its declared rules. */
export function checkHostProfiles(ctx: HostRulesContext): void {
    const { host, registry } = ctx;
    const caps = hostCapabilities(registry, host.profiles);
    const describe = (c: string) => describeCapability(registry, c);
    const reportedConflicts = new Set<string>();

    for (const name of activeProfiles(host.profiles)) {
        const def = registry[name];
        if (!def) continue; // reported by the resolver
        const settings = host.profiles[name];
        const at = `hosts.${host.name}.profiles.${name}`;

        for (const required of activeRequirements(def, settings)) {
            const providers = (caps.get(required) ?? []).filter(p => p !== name);
            if (providers.length === 0) ctx.error(at, `needs ${describe(required)} on the same host`);
        }

        for (const conflict of def.conflicts ?? []) {
            for (const other of (caps.get(conflict) ?? []).filter(p => p !== name)) {
                const key = [name, other].sort().join("+");
                if (reportedConflicts.has(key)) continue;
                reportedConflicts.add(key);
                ctx.error(`hosts.${host.name}.profiles`, `${[name, other].sort().join(" and ")} can't run on the same host`);
            }
        }

        if (def.hostKinds && !def.hostKinds.includes(host.kind)) {
            ctx.error(at, `only runs on ${def.hostKinds.map(k => (k === "harvester" ? "Harvester VMs" : "existing (ssh) machines")).join(" or ")}`);
        }
        for (const feature of def.networkFeatures ?? []) {
            if (host.kind === "harvester" && !ctx.networkFeatures.includes(feature)) {
                ctx.error(at, `needs the host's network to have a ${feature} section on its Harvester`);
            }
        }

        if (def.osFamilies && ctx.osFamily && !def.osFamilies.includes(ctx.osFamily)) {
            ctx.error(at, `needs an OS of the ${def.osFamilies.join(" or ")} family; "${host.os}" is ${ctx.osFamily}`);
        }

        for (const ref of def.hostRefs ?? []) {
            const target = settings[ref.field];
            if (typeof target !== "string") continue; // the schema reports missing fields
            const targetProfiles = ctx.profilesOf(target);
            if (target === host.name) ctx.error(`${at}.${ref.field}`, "can't point at its own host");
            else if (!targetProfiles) ctx.error(`${at}.${ref.field}`, `unknown host "${target}"`);
            else if (!hostCapabilities(registry, targetProfiles).has(ref.provides)) ctx.error(`${at}.${ref.field}`, `host "${target}" doesn't run ${describe(ref.provides)}`);
        }

        const values = settings.values as Record<string, unknown> | undefined;
        for (const leaf of values ? valuePaths(values) : []) {
            const owned = (def.protectedValues ?? []).find(p => leaf === p || leaf.startsWith(`${p}.`) || p.startsWith(`${leaf}.`));
            if (owned) ctx.error(`${at}.values.${leaf}`, `is set by the lab engine (${owned}); it can't be overridden`);
        }

        const declared = secretFieldsOf(def);
        for (const { field, shape } of declared) {
            ctx.secretField(getPath(settings, field) as SecretRef | string | Credentials | undefined, `${at}.${field}`, shape);
        }
        // Any other { $secret } in the settings is a plain string secret.
        walkSecretRefs(settings, at, ctx.secretRef, new Set(declared.map(d => `${at}.${d.field}`)));
    }
}


function walkSecretRefs(value: unknown, path: string, found: (ref: SecretRef, path: string) => void, skip: Set<string>): void {
    if (skip.has(path)) return;
    if (Array.isArray(value)) {
        value.forEach((v, i) => walkSecretRefs(v, `${path}[${i}]`, found, skip));
    } else if (typeof value === "object" && value !== null) {
        if ("$secret" in value && typeof (value as SecretRef).$secret === "string") {
            found(value as SecretRef, path);
            return;
        }
        for (const [k, v] of Object.entries(value)) walkSecretRefs(v, `${path}.${k}`, found, skip);
    }
}

/**
 * Order the profiles on a host so every profile comes after the ones providing what it
 * `requires` (k3s before rancher). Ties keep alphabetical order, so the result is stable.
 */
export function profileBuildOrder(registry: ProfileRegistry, profiles: Profiles): string[] {
    const names = activeProfiles(profiles);
    const caps = hostCapabilities(registry, profiles);
    const deps = new Map(names.map(n => [n, new Set(
        [...activeRequirements(registry[n], profiles[n]), ...(registry[n].uses ?? [])]
            .flatMap(c => caps.get(c) ?? []).filter(p => p !== n),
    )]));
    const order: string[] = [];
    while (order.length < names.length) {
        const next = names.find(n => !order.includes(n) && [...deps.get(n)!].every(d => order.includes(d)));
        if (!next) throw new Error(`profiles on a host depend on each other in a cycle: ${names.filter(n => !order.includes(n)).join(", ")}`);
        order.push(next);
    }
    return order;
}

/** Whether a host may become a node of a Rancher custom cluster, which brings its own Kubernetes. */
export function blocksCustomClusterNode(registry: ProfileRegistry, profiles: Profiles): string[] {
    return activeProfiles(profiles).filter(n => {
        const def = registry[n];
        return capabilitiesOf(def).includes("kubernetes") || (def.conflicts ?? []).includes("kubernetes");
    });
}
