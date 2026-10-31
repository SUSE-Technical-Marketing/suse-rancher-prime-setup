import { z } from "zod";
import { Diagnostics } from "./diagnostics";
import { dnsLabel } from "./primitives";
import { Objects } from "./objects";

// Fleet in the catalog (DESIGN.md §16.3): GitRepos, HelmOps and the ClusterGroups they target. The
// secrets their bundles need are catalog secrets (§16.6), placed on the Rancher cluster.

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

/**
 * One HelmOp: a chart that Fleet's agents install straight from its repo. Unlike a chart in a
 * GitRepo, the chart itself never goes into the Bundle, so a big one (suse-observability) stays
 * under etcd's request limit.
 */
export const FleetHelmOpInput = z.strictObject({
    description: z.string().optional(),
    /** Created by a `rancher` profile that doesn't list `fleet.helmOps`. */
    default: z.boolean().optional(),
    /** A Helm repository (https://) or an OCI registry (oci://). */
    repo: z.string().min(1).optional(),
    chart: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    releaseName: z.string().min(1).optional(),
    /** Where the chart goes on the downstream clusters. */
    defaultNamespace: z.string().min(1).optional(),
    /** The HelmOp's namespace on the Rancher cluster; default fleet-default. */
    namespace: z.string().min(1).optional(),
    /** Helm values; Fleet's `${ }` templates over the target cluster work in them, as in a fleet.yaml. */
    values: z.record(z.string(), z.unknown()).optional(),
    /** As in a fleet.yaml: values from ConfigMaps and Secrets on the downstream cluster. */
    valuesFrom: z.array(z.record(z.string(), z.unknown())).optional(),
    /** Copied to the Bundle, for other bundles' dependsOn. */
    labels: z.record(z.string(), z.string()).optional(),
    /** A ClusterGroup from `catalog.fleet.groups`. */
    target: dnsLabel.optional(),
    /** Or the clusters with these labels. Neither: none (a HelmOp has no default targets). */
    selector: ClusterSelector.optional(),
    /** Fleet's `diff` options, as in a fleet.yaml. */
    diff: z.record(z.string(), z.unknown()).optional(),
    /** The catalog secret with the login for a private repo (helmSecretName). */
    helm: z.strictObject({ secret: dnsLabel }).optional(),
    /** Catalog secrets placed with it when they can be built, like a repo's `uses`. */
    uses: z.array(dnsLabel).optional(),
});
export type FleetHelmOpInput = z.infer<typeof FleetHelmOpInput>;

/**
 * A Fleet profile: labels and annotations for a downstream cluster, which the lab's Fleet repos and
 * HelmOps select on (`needs-security: "true"`) and read (`hosted-domain`). It installs nothing
 * itself: Fleet does, on the clusters Rancher manages. Values are templates over `lab` and `cluster`
 * (`name`, `type`, `rancher`: the Rancher host's name).
 */
export const FleetProfileInput = z.strictObject({
    /** Its icon in the lab UI: a Lucide icon name. */
    icon: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a Lucide icon name like hard-drive").optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
    /** Capabilities the cluster's other Fleet profiles must provide (each provides its own name). */
    requires: z.array(z.string().min(1)).optional(),
    provides: z.array(z.string().min(1)).optional(),
    /** Capabilities no other Fleet profile on the same cluster may provide. */
    conflicts: z.array(z.string().min(1)).optional(),
});
export type FleetProfileInput = z.infer<typeof FleetProfileInput>;

export const FleetCatalogInput = z.strictObject({
    groups: z.record(dnsLabel, ClusterSelector).default({}),
    repos: z.record(dnsLabel, FleetRepoInput).default({}),
    helmOps: z.record(dnsLabel, FleetHelmOpInput).default({}),
});
export type FleetCatalogInput = z.infer<typeof FleetCatalogInput>;

/** A `rancher` profile's `fleet` settings. */
export const FleetSettings = z.strictObject({
    /** GitRepos to create, by catalog name; default: the catalog repos with `default: true`. `[]`: none. */
    repos: z.array(dnsLabel).optional(),
    /** HelmOps to create, by catalog name; default: the catalog HelmOps with `default: true`. `[]`: none. */
    helmOps: z.array(dnsLabel).optional(),
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

export interface ResolvedFleetHelmOp {
    name: string;
    namespace: string;
    repo: string;
    chart: string;
    version?: string;
    releaseName?: string;
    defaultNamespace?: string;
    values?: Record<string, unknown>;
    valuesFrom?: Record<string, unknown>[];
    labels?: Record<string, string>;
    target?: string;
    selector?: ClusterSelector;
    diff?: Record<string, unknown>;
    helmSecret?: string;
}

export interface ResolvedFleet {
    groups: Record<string, ClusterSelector>;
    repos: ResolvedFleetRepo[];
    helmOps: ResolvedFleetHelmOp[];
    /** Repos that aren't created, and what they wait for (shown by `lab plan`). */
    skipped: { what: string; missing: string[] }[];
}

type Sourced<T> = { value: T; source: string };

export interface FleetContext {
    catalog: { groups: Record<string, Sourced<ClusterSelector>>; repos: Record<string, Sourced<FleetRepoInput>>; helmOps: Record<string, Sourced<FleetHelmOpInput>> };
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

/** Pick a `rancher` profile's GitRepos and HelmOps from the catalog and place the secrets they need. */
export function resolveFleet(ctx: FleetContext): ResolvedFleet {
    const { diags, at, labSource: L, catalog, objects } = ctx;
    // Every catalog group is created: repos target them, and so can anything made in the UI.
    const groups = Object.fromEntries(Object.entries(catalog.groups).map(([name, g]) => [name, g.value]));
    const result: ResolvedFleet = { groups, repos: [], helmOps: [], skipped: [] };

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

    const explicitOps = ctx.fleet.helmOps !== undefined;
    const pickedOps = ctx.fleet.helmOps ?? Object.keys(catalog.helmOps).sort().filter(h => catalog.helmOps[h].value.default);
    pickedOps.forEach((name, i) => {
        const pickAt = `${at}.fleet.helmOps[${i}]`;
        const entry = catalog.helmOps[name];
        if (!entry) {
            diags.error(L, pickAt, `unknown Fleet HelmOp "${name}"; known: ${Object.keys(catalog.helmOps).sort().join(", ") || "none"}`);
            return;
        }
        const { value: op, source } = entry;
        const oAt = `catalog.fleet.helmOps.${name}`;
        if (!op.repo || !op.chart) {
            diags.error(source, oAt, "needs a repo and a chart");
            return;
        }
        if (op.target && op.selector) {
            diags.error(source, oAt, "has both a target and a selector; give one");
            return;
        }
        if (op.target && !catalog.groups[op.target]) {
            diags.error(source, `${oAt}.target`, `no ClusterGroup "${op.target}" in catalog.fleet.groups`);
            return;
        }
        if (!op.target && !op.selector) diags.warning(source, oAt, "has no target or selector, so Fleet installs it nowhere");
        const namespace = op.namespace ?? DEFAULT_NAMESPACE;
        const place = (secret: string, required: boolean, secretAt: string) => objects.place("Secret", secret, {
            target: { host: ctx.host }, capabilities: ctx.capabilities, namespace, required,
            source: required ? L : source, at: required ? pickAt : secretAt,
        });
        if (op.helm) {
            if (!objects.exists("Secret", op.helm.secret)) {
                diags.error(source, `${oAt}.helm.secret`, `no catalog secret "${op.helm.secret}"`);
                return;
            }
            const helm = place(op.helm.secret, explicitOps, `${oAt}.helm.secret`);
            if (!helm.ok) {
                result.skipped.push({ what: `HelmOp ${name}`, missing: helm.missing });
                return;
            }
        }
        (op.uses ?? []).forEach((secret, j) => {
            if (!objects.exists("Secret", secret)) diags.error(source, `${oAt}.uses[${j}]`, `no catalog secret "${secret}"`);
            else place(secret, false, `${oAt}.uses[${j}]`);
        });
        result.helmOps.push({
            name, namespace, repo: op.repo, chart: op.chart,
            ...(op.version ? { version: op.version } : {}),
            ...(op.releaseName ? { releaseName: op.releaseName } : {}),
            ...(op.defaultNamespace ? { defaultNamespace: op.defaultNamespace } : {}),
            ...(op.values ? { values: op.values } : {}),
            ...(op.valuesFrom ? { valuesFrom: op.valuesFrom } : {}),
            ...(op.labels ? { labels: op.labels } : {}),
            ...(op.target ? { target: op.target } : {}),
            ...(op.selector ? { selector: op.selector } : {}),
            ...(op.diff ? { diff: op.diff } : {}),
            ...(op.helm ? { helmSecret: op.helm.secret } : {}),
        });
    });
    return result;
}
