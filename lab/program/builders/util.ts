import type { HostOutputs, ProfileContext } from "../profiles";

// What the builders share.

/** The resolver guarantees required capabilities exist; this only narrows the type. */
export function need<K extends "kubernetes" | "rancher">(ctx: ProfileContext, capability: K): NonNullable<HostOutputs[K]> {
    const value = ctx.outputs[capability];
    if (!value) throw new Error(`host ${ctx.host.name}: ${capability} isn't available (profile order bug)`);
    return value as NonNullable<HostOutputs[K]>;
}
