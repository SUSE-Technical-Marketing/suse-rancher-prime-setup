import { z } from "zod";
import { ProfileDefinition } from "./define";
import { certManager, outrider, sprouter, traefik } from "./apps";
import { hauler } from "./hauler";
import { harvesterCloudProvider } from "./harvester";
import { k3s, rke2 } from "./kubernetes";
import { mlmClient, mlmServer } from "./mlm";
import { rancher } from "./rancher";

export * from "./define";

/**
 * Every profile the lab engine knows. Adding a profile: define it in its own file, add it here,
 * and add its builder to `program/profiles.ts` (the typechecker insists on that).
 */
export const PROFILES = [k3s, rke2, harvesterCloudProvider, certManager, sprouter, traefik, outrider, rancher, hauler, mlmServer, mlmClient] as const;

type AnyProfile = (typeof PROFILES)[number];
export type ProfileName = AnyProfile["name"];
export type ProfileSettings<N extends ProfileName> = z.infer<Extract<AnyProfile, { name: N }>["settings"]>;

export const PROFILE_BY_NAME: Record<ProfileName, ProfileDefinition> = Object.fromEntries(PROFILES.map(p => [p.name, p])) as unknown as Record<ProfileName, ProfileDefinition>;

type ProfilesShape = { [P in AnyProfile as P["name"]]: z.ZodOptional<P["settings"]> };

/** `profiles:` on a host: any subset of the known profiles, each with its own settings. */
export const Profiles = z.strictObject(
    Object.fromEntries(PROFILES.map(p => [p.name, p.settings.optional()])) as ProfilesShape,
);
export type Profiles = z.infer<typeof Profiles>;

/** Capabilities a profile gives its host: its own name plus `provides`. */
export function capabilitiesOf(profile: ProfileDefinition): string[] {
    return [profile.name, ...(profile.provides ?? [])];
}

/** The profiles that provide a capability, for messages like "kubernetes (k3s or rke2)". */
export function providersOf(capability: string): ProfileName[] {
    return PROFILES.filter(p => capabilitiesOf(p).includes(capability)).map(p => p.name);
}
