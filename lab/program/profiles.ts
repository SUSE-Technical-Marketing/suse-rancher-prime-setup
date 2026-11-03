import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { stringify } from "yaml";
import { ChartProfile } from "@lab/apps";
import { ClusterAccess, ClusterObjects, helmApp, HostAccess, KubeAdmitted, mergeValues, type ProfileChartSpec, type RenderedProfileChart } from "@lab/kubernetes";
import { HarvesterAddon, type HarvesterBase } from "@lab/harvester";
import type { RancherAccess } from "@lab/rancher";
import type { RenderedObject, ResolvedDownstream, ResolvedHarvester, ResolvedHost, ResolvedLab, ResolvedOs } from "@lab/schema";
import type { ProfileSettings } from "./generated/profile-settings";
import { chartValuesWithSecrets, objectValue } from "./secrets";
import { chart, manifest, profileChart, version } from "./catalog";
import { harvesterCloudProvider } from "./builders/harvester-cloud-provider";
import { hauler } from "./builders/hauler";
import { kubernetesBuilder } from "./builders/kubernetes";
import { landlock } from "./builders/landlock";
import { rancher } from "./builders/rancher";
import { observabilityAgent } from "./builders/suse-observability-agent";
import { need } from "./builders/util";

/** What a host's profiles hand on in code: access to its cluster and to Rancher, and Rancher's Fleet. */
interface HostAccessOutputs {
    kubernetes?: ClusterAccess;
    rancher?: RancherAccess;
    /** The Rancher's Fleet HelmOps and GitRepos: what SUSE Observability agents wait for (their observer's install). */
    fleet?: pulumi.Resource[];
}

/**
 * What a host offers to the profiles built after it (DESIGN.md §7.6): access, and by capability
 * when it's ready. The build loop fills `ready` from each profile's `provides` (its Profile
 * document), so no builder names another profile's capabilities. Data a profile offers (a secret
 * name, an ingress class) is declared in its Profile's `outputs` and read by templates (`host.outputs`).
 */
export interface HostOutputs extends HostAccessOutputs {
    ready: Record<string, pulumi.Resource[]>;
}

/** Everything a host's profiles made is ready: each capability, and Rancher's Fleet installs. */
export const hostReady = (outputs: HostOutputs): pulumi.Resource[] => [...Object.values(outputs.ready).flat(), ...(outputs.fleet ?? [])];

/**
 * What a profile's `host` step made: access it hands on, and when it's ready. The build loop
 * reports `ready` under each capability the profile provides on the host, unless `capabilities`
 * has its own for it (k3s's fallbacks: its ServiceLB, Traefik and Gateway API, each ready apart).
 */
export interface HostBuilt extends HostAccessOutputs {
    ready?: pulumi.Resource[];
    capabilities?: Record<string, pulumi.Resource[]>;
}

export interface CloudInitContext {
    lab: ResolvedLab;
    host: ResolvedHost;
}

export interface ProfileContext extends CloudInitContext {
    access: HostAccess;
    /** The VM, for a Harvester host: deleting it deletes everything on it. */
    machine?: pulumi.Resource;
    /** The Harvester a VM runs on, and what has to exist there first (namespace, networks, pools). */
    harvester?: { name: string; ready: pulumi.Resource[] };
    /** The host is up and cloud-init has finished. */
    ready: pulumi.Resource[];
    /** What the profile's Profile says it waits for (`requires`, `uses`, `requiresWhen`), ready. */
    after: pulumi.Resource[];
    /** The profile's `charts` entries before its own chart, already installed: its chart waits for them. */
    before: pulumi.Resource[];
    /** Outputs of the profiles already built on this host, in `profileOrder`. */
    outputs: HostOutputs;
    /**
     * The host's catalog Secrets and ConfigMaps (§16.6), created once, after `after`. A profile
     * whose resources need them (Fleet's GitRepos) asks for them; otherwise they're created after
     * all of the host's profiles.
     */
    hostObjects(cluster: ClusterAccess, after: pulumi.Resource[]): ClusterObjects | undefined;
}

/** A profile in the catalog, as the generated settings know it. */
export type ProfileName = keyof ProfileSettings;

/** A node the lab creates (a VM, a cluster's machine): its OS, for what it runs at boot. */
export interface BootContext {
    lab: ResolvedLab;
    os: ResolvedOs;
}

/**
 * A host being set up: an existing machine before its own setup (nothing has run on it yet), a VM
 * once cloud-init is done (`after`).
 */
export interface SetupContext {
    lab: ResolvedLab;
    host: ResolvedHost;
    access: HostAccess;
    os: ResolvedOs;
    /** The VM, for a Harvester host: deleting it deletes everything on it. */
    machine?: pulumi.Resource;
    after: pulumi.Resource[];
}

/** A downstream cluster a profile goes on, once it's Ready and the profiles it waits for are done. */
export interface ClusterProfileContext {
    lab: ResolvedLab;
    cluster: ResolvedDownstream;
    /** What its resources are named under: `downstream/<cluster>`. */
    prefix: string;
    /** Its API, and what deleting it deletes. */
    access: ChartCluster;
    /** The cluster is Ready, its objects are placed, the profiles this one waits for are done. */
    after: pulumi.Resource[];
}

/** A Harvester a profile goes on itself, with its base. */
export interface HarvesterProfileContext {
    lab: ResolvedLab;
    harvester: ResolvedHarvester;
    provider: k8s.Provider;
    /** The Harvester's base: the parent of what goes with it, which its VMs wait for. */
    base: HarvesterBase;
}

/** A cluster something can go on or report to: what to install with, and when it's there. */
export type LabCluster = Pick<ClusterAccess, "provider" | "deletedWith"> & { ready: pulumi.Resource[] };

/** Every cluster of the lab, once all are built: for profiles that reach from one to another. */
export interface LabClusters {
    /** Lab hosts' clusters, by host. */
    hosts: Record<string, LabCluster>;
    /** Downstream clusters, by name. */
    downstream: Record<string, LabCluster>;
    /** Harvesters' own clusters, by name. */
    harvesters: Record<string, { provider: k8s.Provider; ready: pulumi.Resource[] }>;
    /** Each Rancher host's Fleet HelmOps and GitRepos (what Fleet installs on the clusters). */
    fleet: Record<string, pulumi.Resource[]>;
}

/** Where a profile is, in the last phase: a host, a downstream cluster or a Harvester, by name. */
export type ProfileTarget = { kind: "host" | "cluster" | "harvester"; name: string };

export interface LastContext {
    lab: ResolvedLab;
    on: ProfileTarget;
    clusters: LabClusters;
}

/**
 * One profile's build steps, by where it goes (its Profile's `targets`) and when:
 * - `boot`: `bootcmd` lines for the nodes the lab creates (VMs, a cluster's machines), first thing at
 *   every boot, before packages or `runcmd`; a metal cluster's profiles give them to its nodes too.
 * - `setup`: on a host (or a metal cluster's node) before anything else uses it: an existing
 *   machine before its own setup, a VM once cloud-init is done. What it returns, the host's other
 *   steps wait for.
 * - `cloudInit`: what a host runs as root to set it up: a VM's user data, or commands over SSH on an
 *   existing machine, which also runs `uninstall` (scripts; missing ones are skipped) when the lab
 *   goes, because the machine stays.
 * - `host`: on a lab host, once it's up, in the host's build order.
 * - `cluster`: on a downstream cluster, once it's Ready, in the cluster's build order; returns what
 *   it made, the last being what the profiles after it wait for.
 * - `harvester`: on a Harvester itself, with its base: its VMs wait for what it returns.
 * - `last`: once every host, cluster and Harvester is built, on each of them it's on (an agent
 *   reporting to another cluster).
 * A test checks every target a profile declares has one of them.
 */
export interface ProfileBuilder<N extends ProfileName> {
    boot?(ctx: BootContext, settings: ProfileSettings[N]): string[];
    setup?(ctx: SetupContext, settings: ProfileSettings[N]): pulumi.Resource[];
    cloudInit?(ctx: CloudInitContext, settings: ProfileSettings[N]): { runcmd: string[]; uninstall?: string[] };
    host?(ctx: ProfileContext, settings: ProfileSettings[N]): HostBuilt | void;
    cluster?(ctx: ClusterProfileContext, settings: ProfileSettings[N]): pulumi.Resource[];
    harvester?(ctx: HarvesterProfileContext, settings: ProfileSettings[N]): pulumi.Resource[];
    last?(ctx: LastContext, settings: ProfileSettings[N]): void;
}

/**
 * Builders for the profiles that need code (`lab/catalog/profiles/`): computed values, real wiring.
 * A profile that only installs its chart has none; `chartProfileBuilder` installs it. Settings are
 * typed by `ProfileSettings`, generated from the Profile documents (`mise run profile-types`), so a
 * builder reading a setting its profile doesn't declare is a compile error; a test checks that
 * every profile has a builder or a chart. Each builder with code of its own is in builders/. A
 * profile with a `distribution` (k3s, rke2) has the Kubernetes builder for it; none is listed here.
 */
export const BUILDERS: { [N in ProfileName]?: ProfileBuilder<N> } = {
    "harvester-cloud-provider": harvesterCloudProvider,
    rancher,
    hauler,
    "suse-observability-agent": observabilityAgent,
    landlock,
};

type AnyBuilder = ProfileBuilder<ProfileName>;

/**
 * A profile's chart with the secrets its templates name rendered into its values (`field('username')`
 * of a credentials setting gives `{{ secrets.appco.username }}`), kept secret.
 */
function withSecrets(chart: RenderedProfileChart): ProfileChartSpec {
    return { ...chart, defaults: chartValuesWithSecrets(chart.defaults) ?? {}, lockedValues: chartValuesWithSecrets(chart.lockedValues) ?? {} };
}

/**
 * A ChartProfile on a host or a downstream cluster (DESIGN.md §17): its entries in order around its
 * own chart, then its objects. Returns what it made, in order: the last is when it's ready.
 */
export function installChartProfile(
    lab: ResolvedLab, target: ChartTarget, name: string, cluster: ChartCluster,
    settings: { version?: string; values?: Record<string, unknown> }, after: pulumi.Resource[],
): pulumi.Resource[] {
    const p = lab.profileCharts[name];
    const main = p.entries.findIndex(e => e.kind === "chart" && e.main);
    const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
    // Only manifests and extra charts: install them all, in order.
    if (main < 0) return installEntries(lab, target, name, cluster, range(0, p.entries.length), after);
    const before = installEntries(lab, target, name, cluster, range(0, main), after);
    const component = new ChartProfile(`${target.name}/${name}`, {
        cluster,
        chart: withSecrets(profileChart(name, target, lab, settings.version)),
        values: chartValuesWithSecrets(settings.values),
        after: before.length ? before.slice(-1) : after,
    }, { aliases: target.chartValues[name]?.aliases ?? [] });
    const done = [...before, component.release];
    done.push(...installEntries(lab, target, name, cluster, range(main + 1, p.entries.length), [component.release]));
    // Its objects after its charts; it's ready once the last one is.
    const objects = target.chartValues[name]?.objects ?? [];
    if (objects.length > 0) done.push(...applyObjects(lab, `${target.name}/${name}`, cluster, objects, component, done.slice(-1)));
    return done;
}

function chartProfileBuilder(name: string): AnyBuilder {
    return {
        host(ctx, settings) {
            const { lab, host } = ctx;
            const p = lab.profileCharts[name];
            const after = [...ctx.after, ...ctx.before];
            const s = settings as { version?: string; values?: Record<string, unknown> };
            // On a host, the build loop installs the entries before its own chart (ctx.before) and
            // after it: here its chart and its objects.
            const main = p.entries.findIndex(e => e.kind === "chart" && e.main);
            if (main < 0) {
                const done = installEntries(lab, host, name, need(ctx, "kubernetes"), p.entries.map((_, i) => i), after);
                return { ready: done.slice(-1) };
            }
            const cluster = need(ctx, "kubernetes");
            const component = new ChartProfile(`${host.name}/${name}`, {
                cluster,
                chart: withSecrets(profileChart(name, host, lab, s.version)),
                values: chartValuesWithSecrets(s.values),
                after,
            }, { aliases: host.chartValues[name]?.aliases ?? [] });
            const done: pulumi.Resource[] = [component.release];
            const objects = host.chartValues[name]?.objects ?? [];
            if (objects.length > 0) done.push(...applyObjects(lab, `${host.name}/${name}`, cluster, objects, component, done.slice(-1)));
            return { ready: done.slice(-1) };
        },
        cluster(ctx, settings) {
            const target = { name: ctx.prefix, chartValues: ctx.cluster.chartProfiles?.chartValues ?? {} };
            return installChartProfile(ctx.lab, target, name, ctx.access, settings as { version?: string; values?: Record<string, unknown> }, ctx.after);
        },
        harvester: (ctx, settings) => installHarvesterAddon(ctx, name, settings as { version?: string; values?: Record<string, unknown> }),
    };
}

/**
 * A ChartProfile on a Harvester itself (DESIGN.md §17): its chart as a Harvester add-on (listed, and
 * its values shown, under the Harvester's Add-ons), after its objects (what the add-on reads, a
 * Secret with a password). All of it goes with the Harvester's base (its children), so VMs come
 * after it and go before it. Add-ons the lab installs are marked experimental, as Harvester marks
 * those it doesn't ship.
 */
function installHarvesterAddon({ lab, harvester: h, provider, base }: HarvesterProfileContext, name: string, settings: { version?: string; values?: Record<string, unknown> }): pulumi.Resource[] {
    const rendered = h.chartValues[name];
    const entry = lab.profileCharts[name].entries[0];
    if (entry.kind !== "chart") throw new Error(`profile ${name}: an add-on is a chart`);
    const objects = applyObjects(lab, `${h.name}/${name}`, { provider }, rendered.objects, base, []);
    const c = chart(entry.chart, lab, settings.version || rendered.entries[0].version);
    const { values, lockedValues } = rendered.entries[0];
    const valuesContent = pulumi.output(chartValuesWithSecrets(mergeValues(values, settings.values ?? {}, lockedValues)) ?? {})
        .apply(v => stringify(v, { lineWidth: 0 }));
    return [...objects, new HarvesterAddon(`${h.name}/${name}`, {
        harvester: h.name,
        name: entry.chart,
        namespace: entry.namespace,
        labels: { "addon.harvesterhci.io/experimental": "true" },
        // An oci:// chart has no repo: Harvester's helm-controller pulls it by its reference.
        repo: c.repo ?? "",
        chart: c.chart,
        version: c.version,
        valuesContent,
        timeoutSeconds: lab.timeouts.harvesterAddon,
    }, { parent: base, dependsOn: objects, aliases: rendered.aliases, deleteBeforeReplace: true })];
}

/**
 * Install some of a profile's `charts` entries, one after the other (skipping those whose `when` is
 * false): a manifest with its `{version}` and vars filled in, or a chart with its rendered values.
 */
/** Where a profile's entries go: a host, or a downstream cluster (`name` prefixes the resources). */
type ChartTarget = { name: string; chartValues: ResolvedHost["chartValues"] };
/** The cluster a profile's charts and objects go on: its kubeconfig for what the provider can't check (admission). */
export type ChartCluster = Pick<ClusterAccess, "provider" | "deletedWith"> & { kubeconfig?: pulumi.Input<string> };

function installEntries(lab: ResolvedLab, host: ChartTarget, profile: string, cluster: ChartCluster, indices: number[], after: pulumi.Resource[]): pulumi.Resource[] {
    const done: pulumi.Resource[] = [];
    let previous = after;
    for (const i of indices) {
        const entry = lab.profileCharts[profile].entries[i];
        const rendered = host.chartValues[profile].entries[i];
        if (!rendered.install) continue;
        const opts: pulumi.CustomResourceOptions = { provider: cluster.provider, deletedWith: cluster.deletedWith, dependsOn: previous };
        let resource: pulumi.Resource;
        if (entry.kind === "manifest") {
            let url = manifest(entry.manifest, lab).replace(/\{version\}/g, rendered.version ?? version(entry.manifest, lab));
            for (const [k, v] of Object.entries(rendered.vars)) url = url.split(`{${k}}`).join(v);
            resource = new k8s.yaml.v2.ConfigFile(`${host.name}/${profile}/${entry.manifest}`, { file: url }, opts);
        } else {
            resource = helmApp(`${host.name}/${profile}/${entry.chart}`, {
                ...chart(entry.chart, lab, rendered.version),
                namespace: entry.namespace,
                releaseName: entry.chart,
                // A profile's templates can name secrets (`field('username')` of a credentials setting): rendered here, kept secret.
                defaults: chartValuesWithSecrets(rendered.values) ?? {},
                lockedValues: chartValuesWithSecrets(rendered.lockedValues) ?? {},
            }, opts);
        }
        done.push(resource);
        previous = [resource];
    }
    return done;
}

/**
 * A profile's `objects` on its host's cluster, in order, each after the one before (DESIGN.md §17),
 * named `<host>/<profile>/<entry name>` under the profile's component: secret templates rendered and
 * kept secret, `wait` waiting for a condition. Returns them, in order.
 */
function applyObjects(lab: ResolvedLab, prefix: string, cluster: ChartCluster, objects: RenderedObject[], parent: pulumi.Resource, after: pulumi.Resource[]): pulumi.Resource[] {
    const made: pulumi.Resource[] = [];
    for (const { name, object, admitted, wait, aliases } of objects) {
        const { apiVersion, kind, metadata, ...rest } = object as { apiVersion: string; kind: string; metadata?: { annotations?: Record<string, string>; namespace?: string } & Record<string, unknown> };
        // A webhook to answer first: a dry run of it until the API server admits it (as rendered,
        // secret templates unfilled: a dry run for a webhook, not the object).
        let before = made.length ? [made[made.length - 1]] : after;
        if (admitted) {
            if (!cluster.kubeconfig) throw new Error(`${prefix}/${name}: admitted needs the cluster's kubeconfig`);
            const plural = kind.toLowerCase().replace(/(s|x|ch|sh)$/, "$1e").replace(/y$/, "ie") + "s";
            const base = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
            before = [new KubeAdmitted(`${prefix}/${name}/admitted`, {
                kubeconfig: cluster.kubeconfig,
                path: `${base}${metadata?.namespace ? `/namespaces/${metadata.namespace}` : ""}/${plural}`,
                object,
                timeoutSeconds: lab.timeouts.resourceReady,
            }, { parent, dependsOn: before, deletedWith: cluster.deletedWith })];
        }
        const annotations = wait
            ? { ...metadata?.annotations, "pulumi.com/waitFor": `condition=${wait.condition}`, "pulumi.com/timeoutSeconds": String(lab.timeouts[wait.timeout]) }
            : metadata?.annotations;
        // Each top-level field on its own, so a secret one (a Secret's stringData) is the only secret output.
        const fields = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === "object" && v !== null ? chartValuesWithSecrets(v as Record<string, unknown>) ?? v : v]));
        const args = { metadata: { ...metadata, ...(annotations ? { annotations } : {}) }, ...fields };
        const opts: pulumi.CustomResourceOptions = { parent, provider: cluster.provider, deletedWith: cluster.deletedWith, dependsOn: before, ...(aliases ? { aliases: aliases.map(a => ({ name: a })) } : {}) };
        // Core kinds (apiVersion v1, no group) have classes of their own (k8s.core.v1.Secret); the rest are custom resources.
        const Core = apiVersion === "v1" ? (k8s.core.v1 as unknown as Record<string, new (n: string, a: object, o: pulumi.CustomResourceOptions) => pulumi.CustomResource>)[kind] : undefined;
        if (apiVersion === "v1" && !Core) throw new Error(`${prefix}/${name}: no core kind ${kind}`);
        made.push(Core ? new Core(`${prefix}/${name}`, args, opts) : new k8s.apiextensions.CustomResource(`${prefix}/${name}`, { apiVersion, kind, ...args }, opts));
    }
    return made;
}

/** A profile's builder: its own, the Kubernetes one for its distribution, or the generic one for a chart-only profile. */
export function builderOf(lab: ResolvedLab, name: string): AnyBuilder {
    const builder = BUILDERS[name as ProfileName] as unknown as AnyBuilder | undefined;
    if (builder) return builder;
    const dist = lab.profiles[name]?.distribution;
    if (dist) return kubernetesBuilder(name, dist);
    if (lab.profileCharts[name]) return chartProfileBuilder(name);
    throw new Error(`profile ${name} has neither a builder in program/profiles.ts, a distribution, nor a chart`);
}
const settingsOf = (host: ResolvedHost, name: string) => host.profiles[name] as unknown as ProfileSettings[ProfileName];

const cloudInits = (lab: ResolvedLab, host: ResolvedHost) =>
    host.profileOrder.map(name => builderOf(lab, name).cloudInit?.({ lab, host }, settingsOf(host, name)));

/** cloud-init `runcmd` lines the host's profiles contribute, in build order. */
export function profileCloudInit(lab: ResolvedLab, host: ResolvedHost): string[] {
    return cloudInits(lab, host).flatMap(c => c?.runcmd ?? []);
}

/** Uninstall scripts of the host's profiles, last built first: for an existing machine. */
export function profileUninstall(lab: ResolvedLab, host: ResolvedHost): string[] {
    return cloudInits(lab, host).reverse().flatMap(c => c?.uninstall ?? []);
}

/** Build a host's profiles in the order the resolver worked out from their rules. */
export function buildHostProfiles(
    lab: ResolvedLab,
    host: ResolvedHost,
    access: HostAccess,
    ready: pulumi.Resource[],
    machine?: pulumi.Resource,
    harvester?: ProfileContext["harvester"],
): HostOutputs {
    const outputs: HostOutputs = { ready: {} };
    let objects: ClusterObjects | undefined;
    const hostObjects = (cluster: ClusterAccess, after: pulumi.Resource[]) => {
        const list = lab.objects.filter(o => "host" in o.target && o.target.host === host.name);
        if (!objects && list.length > 0) {
            objects = new ClusterObjects(`${host.name}/objects`, { objects: list, value: objectValue }, {
                provider: cluster.provider, deletedWith: cluster.deletedWith, dependsOn: after,
            });
        }
        return objects;
    };
    for (const name of host.profileOrder) {
        // A profile's other `charts` entries go around its own chart: those before it first, those after it once it's ready.
        const entries = lab.profileCharts[name]?.entries ?? [];
        const main = entries.findIndex(e => e.kind === "chart" && e.main);
        const cluster = outputs.kubernetes;
        const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
        const after = lab.profiles[name].waitFor.flatMap(c => outputs.ready[c] ?? []);
        const before = cluster && main > 0 ? installEntries(lab, host, name, cluster, range(0, main), after) : [];
        const { ready: own = [], capabilities = {}, ...handed } = builderOf(lab, name).host?.({ lab, host, access, ready, machine, harvester, outputs, hostObjects, after, before }, settingsOf(host, name)) ?? {};
        Object.assign(outputs, handed);
        // Each capability it provides here (a fallback only when no other profile does), ready when it says.
        for (const c of lab.profiles[name].provides.concat(Object.keys(capabilities))) {
            if (host.providers[c]?.includes(name)) outputs.ready[c] = capabilities[c] ?? own;
        }
        if (cluster && main >= 0 && main < entries.length - 1) {
            installEntries(lab, host, name, cluster, range(main + 1, entries.length), [...own, ...Object.values(capabilities).flat()]);
        }
    }
    // Not asked for by a profile: after everything the host's profiles made.
    if (outputs.kubernetes) {
        const cluster = outputs.kubernetes;
        const allReady = hostReady(outputs);
        const objectsDone = hostObjects(cluster, allReady)?.resources ?? [];
        // Catalog charts placed on the host (`charts:`), after its profiles and objects (DESIGN.md §17).
        for (const c of host.charts) {
            helmApp(`${host.name}/charts/${c.name}`, {
                chart: c.chart,
                ...(c.repo ? { repo: c.repo } : {}),
                version: c.version,
                namespace: c.namespace,
                releaseName: c.name,
                values: chartValuesWithSecrets(c.values) ?? {},
            }, { provider: cluster.provider, deletedWith: cluster.deletedWith, dependsOn: [...allReady, ...objectsDone] });
        }
    }
    return outputs;
}

/**
 * A downstream cluster's profiles in build order, once it's Ready (DESIGN.md §17): each after the
 * profiles it requires or uses. Returns, by capability, what the profiles providing it made.
 */
export function buildClusterProfiles(lab: ResolvedLab, cluster: ResolvedDownstream, access: ChartCluster, after: pulumi.Resource[]): Record<string, pulumi.Resource[]> {
    const ready: Record<string, pulumi.Resource[]> = {};
    const cp = cluster.chartProfiles;
    if (!cp) return ready;
    for (const name of cp.order) {
        const builder = builderOf(lab, name);
        if (!builder.cluster) continue;
        const p = lab.profiles[name];
        const waitFor = p.waitFor.flatMap(c => ready[c] ?? []);
        const done = builder.cluster({ lab, cluster, prefix: `downstream/${cluster.name}`, access, after: [...after, ...waitFor] }, cp.profiles[name] as never);
        for (const c of p.provides) ready[c] = done.slice(-1);
    }
    return ready;
}

/** A Harvester's own profiles, with its base: returns what its VMs wait for. */
export function buildHarvesterProfiles(lab: ResolvedLab, harvester: ResolvedHarvester, provider: k8s.Provider, base: HarvesterBase): pulumi.Resource[] {
    return Object.keys(harvester.profiles).sort().flatMap(name =>
        builderOf(lab, name).harvester?.({ lab, harvester, provider, base }, harvester.profiles[name] as never) ?? []);
}

/** Every profile's `last` step, on each host, downstream cluster and Harvester it's on, in their build order. */
export function buildLastProfiles(lab: ResolvedLab, clusters: LabClusters): void {
    const run = (profiles: [string, unknown][], on: ProfileTarget) => {
        for (const [name, settings] of profiles) builderOf(lab, name).last?.({ lab, on, clusters }, settings as never);
    };
    for (const host of lab.hosts) run(ordered(host.profiles, host.profileOrder), { kind: "host", name: host.name });
    for (const d of lab.downstream) run(clusterProfiles(d), { kind: "cluster", name: d.name });
    for (const h of lab.harvesters) run(ordered(h.profiles, Object.keys(h.profiles).sort()), { kind: "harvester", name: h.name });
}

/** Profiles as [name, settings], in the given order. */
const ordered = (profiles: Record<string, unknown>, order: string[]): [string, unknown][] => order.map(name => [name, profiles[name]]);

/** A downstream cluster's profiles, in its build order. */
export const clusterProfiles = (d: ResolvedDownstream): [string, unknown][] => (d.chartProfiles ? ordered(d.chartProfiles.profiles, d.chartProfiles.order) : []);

/**
 * The profiles acting on a host as a node, in build order: those of the metal cluster it's a node of
 * (Landlock on every node), then its own.
 */
export function nodeProfiles(lab: ResolvedLab, host: ResolvedHost): [string, unknown][] {
    const metal = lab.downstream.find(d => d.type === "metal" && d.nodes.some(n => n.host === host.name));
    return [...(metal ? clusterProfiles(metal) : []), ...ordered(host.profiles, host.profileOrder)];
}

/** `bootcmd` lines the profiles give a node the lab creates with this OS. */
export function profileBootcmd(lab: ResolvedLab, profiles: [string, unknown][], os: ResolvedOs): string[] {
    return profiles.flatMap(([name, settings]) => builderOf(lab, name).boot?.({ lab, os }, settings as never) ?? []);
}

/** The node profiles' `setup` steps on a host, after `after`: what its later steps wait for (`after` when there are none). */
export function profileSetup(lab: ResolvedLab, host: ResolvedHost, ctx: Omit<SetupContext, "lab" | "host">): pulumi.Resource[] {
    const made = nodeProfiles(lab, host).flatMap(([name, settings]) => builderOf(lab, name).setup?.({ lab, host, ...ctx }, settings as never) ?? []);
    return made.length > 0 ? made : ctx.after;
}
