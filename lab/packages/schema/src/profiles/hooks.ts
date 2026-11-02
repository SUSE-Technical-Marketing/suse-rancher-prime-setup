import type { ResolvedOs } from "../os";
import { assertNever } from "../exhaustive";
import type { ResolvedDownstream } from "../resolve";

/**
 * What a profile checks beyond its declared rules (DESIGN.md §7.6): things only code can say, about
 * the lab around it. The resolver runs them for every host, downstream cluster and Harvester the
 * profile is on, once everything is resolved; the program's builders (program/profiles.ts) are
 * their counterpart at build time.
 */
export interface HookContext {
    /** Report an error at a path (`hosts.vm.profiles.landlock`). */
    error(path: string, message: string): void;
    /** An OS profile, by name; undefined when there's none (reported elsewhere). */
    os(name: string): ResolvedOs | undefined;
    /** A lab host's OS profile name, by host; undefined for an unknown host. */
    hostOs(name: string): string | undefined;
    /** The lab's ACME server (`tls.acme`): `none` when it has none. */
    acme: string;
}

export interface ProfileHooks {
    host?(ctx: HookContext, host: { name: string; os: string }, settings: Record<string, unknown>, at: string): void;
    cluster?(ctx: HookContext, cluster: ResolvedDownstream, settings: Record<string, unknown>, at: string): void;
    harvester?(ctx: HookContext, harvester: { name: string }, settings: Record<string, unknown>, at: string): void;
}

// --- landlock ----------------------------------------------------------------------------------
// Turned on per node by the OS profile's `landlock.enable` (DESIGN.md §9.7).
const LANDLOCK_HOW = "doesn't say how to turn Landlock on: it has no landlock.enable";
const noLandlock = (ctx: HookContext, os: string, at: string) => {
    if (ctx.os(os) && !ctx.os(os)!.landlock) ctx.error(at, `OS profile ${os} ${LANDLOCK_HOW}`);
};
const landlock: ProfileHooks = {
    host: (ctx, host, _s, at) => noLandlock(ctx, host.os, at),
    cluster(ctx, d, _s, at) {
        switch (d.type) {
            case "k3k":
                ctx.error(at, `a k3k cluster runs on its parent's nodes: put landlock on ${d.parent}`);
                break;
            case "eks":
                ctx.error(at, "the lab doesn't make an EKS cluster's node images, so it can't turn Landlock on there");
                break;
            case "harvester":
            case "ec2":
                d.pools.forEach((pool, i) => noLandlock(ctx, pool.os, `downstream.${d.name}.pools[${i}].os`));
                break;
            case "metal":
                for (const node of d.nodes) {
                    const os = ctx.hostOs(node.host);
                    if (os) noLandlock(ctx, os, `${at} (node ${node.host})`);
                }
                break;
            default:
                assertNever(d, "downstream cluster type");
        }
    },
};

// --- harvester-dns-controller --------------------------------------------------------------------
/** The DNS controller's `dns` values the engine sets, and where each comes from (the profile's settings). */
const DNS_FIELD: Record<string, string> = {
    backend: "from backend", host: "from host", username: "from credentials", password: "from credentials",
    existingSecret: "from credentials", ttl: "from ttl", useTls: "from useTls", tlsVerify: "from tlsVerify",
    domain: "(the lab's domain)",
    // Its records on the router, by comment: one tag per Harvester, so controllers sharing a router
    // never clean up each other's.
    commentTag: "(managed-by=harvester-dns-controller/<the Harvester's name>)",
};
const dnsController: ProfileHooks = {
    // What the engine sets on the DNS controller: its own fields and the lab's.
    harvester(ctx, _h, settings, at) {
        const values = (settings.values ?? {}) as Record<string, unknown>;
        for (const [key, inner] of [["dns", Object.keys(DNS_FIELD)], ["watchNamespaces", undefined]] as const) {
            const given = values[key];
            if (given === undefined) continue;
            const taken = inner ? Object.keys(given as object).filter(k => inner.includes(k)) : [key];
            for (const k of taken) ctx.error(`${at}.values.${inner ? `${key}.${k}` : k}`, inner
                ? `is set by the lab engine ${DNS_FIELD[k]}; it can't be overridden`
                : "is set by the lab engine (the lab's namespace); it can't be overridden");
        }
    },
};

// --- cert-manager ----------------------------------------------------------------------------------
// It issues the lab's certificates from its ACME server: without one it has nothing to do.
const NO_ACME = "issues certificates from the lab's ACME server; set tls.acme (and tls.email, tls.cloudflare), not none";
const certManager: ProfileHooks = {
    host: (ctx, _h, _s, at) => { if (ctx.acme === "none") ctx.error(at, NO_ACME); },
    cluster: (ctx, _d, _s, at) => { if (ctx.acme === "none") ctx.error(at, NO_ACME); },
};

/** The profiles with checks of their own, by name. */
export const PROFILE_HOOKS: Record<string, ProfileHooks> = {
    landlock,
    "harvester-dns-controller": dnsController,
    "cert-manager": certManager,
};
