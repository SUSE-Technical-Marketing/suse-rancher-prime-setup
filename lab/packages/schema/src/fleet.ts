import { z } from "zod";
import { Diagnostics } from "./diagnostics";
import { dnsLabel } from "./primitives";
import { Objects } from "./objects";

// Fleet in the catalog (DESIGN.md §16.3): GitRepos and the ClusterGroups they target. The secrets
// their bundles need are catalog secrets (§16.6), placed on the Rancher cluster.

/** A ClusterGroup's cluster selector. */
export const ClusterSelector = z.strictObject({
    matchLabels: z.record(z.string(), z.string()).optional(),
    matchExpressions: z.array(z.strictObject({
        key: z.string().min(1),
        operator: z.enum(["In", "NotIn", "Exists", "DoesNotExist"]),
        values: z.array(z.string()).optional(),
    })).optional(),
});
export type ClusterSelector = z.infer<typeof ClusterSelector>;

/** One GitRepo. */
export const FleetRepoInput = z.strictObject({
    description: z.string().optional(),
    /** Created by a `rancher` profile that doesn't list `fleet.repos`. */
    default: z.boolean().optional(),
    url: z.url().optional(),
    branch: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
    namespace: z.string().min(1).optional(),
    /** A ClusterGroup from `catalog.fleet.groups`; none: Fleet's default targets. */
    target: dnsLabel.optional(),
    /** The catalog secret with the Helm login for the repo's charts: Fleet rejects the GitRepo without it. */
    helm: z.strictObject({ secret: dnsLabel, repoURLRegex: z.string().min(1).optional() }).optional(),
    /**
     * Catalog secrets the repo's bundles read when they're there, like a profile's `uses`: created
     * with the repo when they can be built. (`helm.secret` is the one it requires.)
     */
    uses: z.array(dnsLabel).optional(),
});
export type FleetRepoInput = z.infer<typeof FleetRepoInput>;

export const FleetCatalogInput = z.strictObject({
    groups: z.record(dnsLabel, ClusterSelector).default({}),
    repos: z.record(dnsLabel, FleetRepoInput).default({}),
});
export type FleetCatalogInput = z.infer<typeof FleetCatalogInput>;

/** A `rancher` profile's `fleet` settings. */
export const FleetSettings = z.strictObject({
    /** GitRepos to create, by catalog name; default: the catalog repos with `default: true`. `[]`: none. */
    repos: z.array(dnsLabel).optional(),
});
export type FleetSettings = z.infer<typeof FleetSettings>;

// ---------------------------------------------------------------------------------------------

export interface ResolvedFleetRepo {
    name: string;
    namespace: string;
    url: string;
    branch: string;
    paths: string[];
    target?: string;
    helm?: { secret: string; repoURLRegex?: string };
}

export interface ResolvedFleet {
    groups: Record<string, ClusterSelector>;
    repos: ResolvedFleetRepo[];
    /** Repos that aren't created, and what they wait for (shown by `lab plan`). */
    skipped: { what: string; missing: string[] }[];
}

type Sourced<T> = { value: T; source: string };

export interface FleetContext {
    catalog: { groups: Record<string, Sourced<ClusterSelector>>; repos: Record<string, Sourced<FleetRepoInput>> };
    fleet: FleetSettings;
    /** The host running Rancher, its capabilities, and the profile's path for messages. */
    host: string;
    capabilities: { has(capability: string): boolean };
    at: string;
    labSource: string;
    objects: Objects;
    diags: Diagnostics;
}

const DEFAULT_NAMESPACE = "fleet-default";

/** Pick a `rancher` profile's GitRepos from the catalog and place the secrets they need. */
export function resolveFleet(ctx: FleetContext): ResolvedFleet {
    const { diags, at, labSource: L, catalog, objects } = ctx;
    // Every catalog group is created: repos target them, and so can anything made in the UI.
    const groups = Object.fromEntries(Object.entries(catalog.groups).map(([name, g]) => [name, g.value]));
    const result: ResolvedFleet = { groups, repos: [], skipped: [] };

    const explicit = ctx.fleet.repos !== undefined;
    const selected = ctx.fleet.repos ?? Object.keys(catalog.repos).sort().filter(r => catalog.repos[r].value.default);
    selected.forEach((name, i) => {
        const pickAt = `${at}.fleet.repos[${i}]`;
        const entry = catalog.repos[name];
        if (!entry) {
            diags.error(L, pickAt, `unknown Fleet repo "${name}"; known: ${Object.keys(catalog.repos).sort().join(", ") || "none"}`);
            return;
        }
        const { value: repo, source } = entry;
        const rAt = `catalog.fleet.repos.${name}`;
        if (!repo.url) {
            diags.error(source, rAt, "needs a url");
            return;
        }
        if (repo.target && !catalog.groups[repo.target]) {
            diags.error(source, `${rAt}.target`, `no ClusterGroup "${repo.target}" in catalog.fleet.groups`);
            return;
        }
        const namespace = repo.namespace ?? DEFAULT_NAMESPACE;
        // Secrets go in the GitRepo's namespace on the Rancher cluster: that's where Fleet looks.
        const place = (secret: string, required: boolean, secretAt: string) => objects.place("Secret", secret, {
            target: { host: ctx.host }, capabilities: ctx.capabilities, namespace, required,
            source: required ? L : source, at: required ? pickAt : secretAt,
        });
        if (repo.helm) {
            if (!objects.exists("Secret", repo.helm.secret)) {
                diags.error(source, `${rAt}.helm.secret`, `no catalog secret "${repo.helm.secret}"`);
                return;
            }
            // Picked by name, the lab expects it: missing inputs are an error. A default repo just drops out.
            const helm = place(repo.helm.secret, explicit, `${rAt}.helm.secret`);
            if (!helm.ok) {
                result.skipped.push({ what: `repo ${name}`, missing: helm.missing });
                return;
            }
        }
        (repo.uses ?? []).forEach((secret, j) => {
            if (!objects.exists("Secret", secret)) diags.error(source, `${rAt}.uses[${j}]`, `no catalog secret "${secret}"`);
            else place(secret, false, `${rAt}.uses[${j}]`);
        });
        result.repos.push({
            name, namespace, url: repo.url,
            branch: repo.branch ?? "main",
            paths: repo.paths ?? [],
            target: repo.target,
            helm: repo.helm,
        });
    });
    return result;
}
