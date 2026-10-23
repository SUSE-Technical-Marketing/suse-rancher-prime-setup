import { ProfileDefinition, ProfileRegistry } from "./define";

export * from "./define";

/** `profiles:` on a host: profile name -> its settings (checked against the catalog by the resolver). */
export type Profiles = Record<string, Record<string, unknown>>;

/** Capabilities a profile gives its host: its own name plus `provides`. */
export function capabilitiesOf(profile: ProfileDefinition): string[] {
    return [profile.name, ...(profile.provides ?? [])];
}

/** The profiles that provide a capability, for messages like "kubernetes (k3s or rke2)"; a fallback counts. */
export function providersOf(registry: ProfileRegistry, capability: string): string[] {
    return Object.values(registry).filter(p => capabilitiesOf(p).includes(capability) || (p.fallback ?? []).includes(capability)).map(p => p.name).sort();
}
