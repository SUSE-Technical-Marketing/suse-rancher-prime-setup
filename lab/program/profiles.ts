import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ChartProfile, HarvesterCloudProvider } from "@lab/apps";
import { HarvesterCloudConfig } from "@lab/harvester";
import { ClusterAccess, clusterFromHost, ClusterObjects, Distro, distroInstall, HaulerRegistry, helmApp, helmJobWatch, HostAccess, KubeAdmitted, KubeWait, type ProfileChartSpec, type RenderedProfileChart } from "@lab/kubernetes";
import { Fleet, RancherAccess, RancherServer, UiPlugins } from "@lab/rancher";
import type { RenderedObject, ResolvedHost, ResolvedLab } from "@lab/schema";
import type { ProfileSettings } from "./generated/profile-settings";
import { chartValuesWithSecrets, objectValue, secretString } from "./secrets";
import { chart, distribution, download, installCommand, manifest, profileChart, version } from "./catalog";

/** What a consumer of a capability has to wait for. */
interface Ready { ready: pulumi.Resource[] }

/**
 * What a host offers to the profiles built after it, keyed by capability (DESIGN.md §7.6): when
 * each is ready, plus access to the cluster and to Rancher. Data a profile offers (a secret name,
 * an ingress class) is declared in its Profile's `outputs` and read by templates (`host.outputs`).
 */
export interface HostOutputs {
    kubernetes?: ClusterAccess;
    "load-balancer"?: Ready;
    "cloud-provider"?: Ready;
    tls?: Ready;
    ingress?: Ready;
    "gateway-api"?: Ready;
    "secret-propagation"?: Ready;
    "downstream-secrets"?: Ready;
    registry?: Ready;
    rancher?: RancherAccess;
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

/**
 * One profile's build steps. `cloudInit` is what the host runs as root to set it up: a VM's user
 * data, or commands over SSH on an existing machine, which also runs `uninstall` (scripts; missing
 * ones are skipped) when the lab goes, because the machine stays. `build` runs once the host is up.
 */
export interface ProfileBuilder<N extends ProfileName> {
    cloudInit?(ctx: CloudInitContext, settings: ProfileSettings[N]): { runcmd: string[]; uninstall?: string[] };
    build(ctx: ProfileContext, settings: ProfileSettings[N]): HostOutputs | void;
}

/** The resolver guarantees required capabilities exist; this only narrows the type. */
function need<K extends keyof HostOutputs>(ctx: ProfileContext, capability: K): NonNullable<HostOutputs[K]> {
    const value = ctx.outputs[capability];
    if (!value) throw new Error(`host ${ctx.host.name}: ${capability} isn't available (profile order bug)`);
    return value as NonNullable<HostOutputs[K]>;
}

const notBuiltYet = (profile: ProfileName, milestone: string) => ({
    build(ctx: ProfileContext): void {
        pulumi.log.warn(`host ${ctx.host.name}: the ${profile} profile isn't built yet (${milestone}); nothing is created for it`);
    },
});

const kubernetesCloudInit = (distro: Distro, { lab, host }: CloudInitContext, own?: string) => {
    const d = distribution(distro, lab);
    return {
        // What other profiles do instead of the distribution (ingress, load balancing, the cloud provider).
        runcmd: [
            helmJobWatch(d, lab.timeouts.helmJobWatch),
            ...distroInstall(d, installCommand(d, version(distro, lab, own)), host.fqdn, { capabilities: byOthers(host, distro) }).runcmd,
        ],
        uninstall: d.uninstall,
    };
};
/** Capabilities other profiles on the host provide: the distribution turns its own off for those. */
const byOthers = (host: ResolvedHost, profile: string) =>
    Object.entries(host.providers).filter(([, providers]) => !providers.includes(profile)).map(([cap]) => cap);

const kubernetesBuild = (distro: Distro, { lab, host, access, ready, machine }: ProfileContext): HostOutputs => {
    const kubernetes = clusterFromHost(`${host.name}/${distro}`, access, { name: distro, ...distribution(distro, lab) }, lab.timeouts.kubernetesApi, { dependsOn: ready, deletedWith: machine });
    const outputs: HostOutputs = { kubernetes };
    // Its own ServiceLB and Traefik (the profile's fallbacks), when no other profile replaces them.
    // Traefik is there once the distribution has installed its IngressClass.
    if (host.providers["load-balancer"]?.includes(distro)) outputs["load-balancer"] = { ready: [] };
    if (host.providers.ingress?.includes(distro)) {
        const ingressClass = String(host.outputs.ingress?.ingressClassName ?? "traefik");
        const ingress = new KubeWait(`${host.name}/${distro}/ingress`, {
            kubeconfig: kubernetes.kubeconfig,
            path: `/apis/networking.k8s.io/v1/ingressclasses/${ingressClass}`,
            timeoutSeconds: lab.timeouts.resourceReady,
        }, { deletedWith: machine });
        outputs.ingress = { ready: [ingress] };

        // The Gateway API on that same Traefik (its gateway-api fallback): its Gateway provider turned
        // on through the distribution's own HelmChartConfig, after the CRDs where the distribution
        // doesn't ship them (k3s); its Helm controller upgrades Traefik, which then has a GatewayClass.
        const own = distribution(distro, lab).ingress;
        const gatewayClass = host.outputs["gateway-api"]?.gatewayClassName;
        if (host.providers["gateway-api"]?.includes(distro) && own?.values && gatewayClass) {
            const crds = (own.manifests ?? []).map(m => new k8s.yaml.v2.ConfigFile(`${host.name}/${distro}/${m}`, {
                file: manifest(m, lab).replace(/\{version\}/g, version(m, lab)).replace(/\{channel\}/g, "standard"),
            }, { provider: kubernetes.provider, deletedWith: machine, dependsOn: [ingress] }));
            const config = new k8s.apiextensions.CustomResource(`${host.name}/${distro}/ingress-config`, {
                apiVersion: "helm.cattle.io/v1",
                kind: "HelmChartConfig",
                metadata: { name: own.chart, namespace: "kube-system" },
                // JSON is YAML too.
                spec: { valuesContent: JSON.stringify(own.values) },
            }, { provider: kubernetes.provider, deletedWith: machine, dependsOn: [ingress, ...crds] });
            outputs["gateway-api"] = {
                ready: [new KubeWait(`${host.name}/${distro}/gateway-class`, {
                    kubeconfig: kubernetes.kubeconfig,
                    path: `/apis/gateway.networking.k8s.io/v1/gatewayclasses/${String(gatewayClass)}`,
                    condition: "Accepted",
                    timeoutSeconds: lab.timeouts.resourceReady,
                }, { deletedWith: machine, dependsOn: [config] })],
            };
        }
    }
    return outputs;
};

/**
 * Builders for the profiles that need code (`lab/catalog/profiles/`): computed values, real wiring.
 * A profile that only installs its chart has none; `chartProfileBuilder` installs it. Settings are
 * typed by `ProfileSettings`, generated from the Profile documents (`mise run profile-types`), so a
 * builder reading a setting its profile doesn't declare is a compile error; a test checks that
 * every profile has a builder or a chart.
 */
export const BUILDERS: { [N in ProfileName]?: ProfileBuilder<N> } = {
    k3s: { cloudInit: (ctx, s) => kubernetesCloudInit("k3s", ctx, s.version), build: ctx => kubernetesBuild("k3s", ctx) },
    rke2: { cloudInit: (ctx, s) => kubernetesCloudInit("rke2", ctx, s.version), build: ctx => kubernetesBuild("rke2", ctx) },

    "harvester-cloud-provider": {
        build(ctx, settings) {
            const { lab, host } = ctx;
            if (!ctx.harvester) throw new Error(`host ${host.name}: harvester-cloud-provider only runs on Harvester VMs`);
            const name = `${host.name}/harvester-cloud-provider`;
            const cloudConfig = new HarvesterCloudConfig(`${name}/cloud-config`, {
                harvester: ctx.harvester.name,
                namespace: lab.name,
                serviceAccountName: `${host.name}-cloud-provider`,
            }, { dependsOn: ctx.harvester.ready });
            const ccm = new HarvesterCloudProvider(name, {
                cluster: need(ctx, "kubernetes"),
                chart: profileChart("harvester-cloud-provider", host, lab, settings.version),
                values: chartValuesWithSecrets(settings.values),
                cloudConfig: cloudConfig.kubeconfig,
            });
            return { "load-balancer": { ready: [ccm.release] }, "cloud-provider": { ready: [ccm.release] } };
        },
    },



    rancher: {
        build(ctx, settings) {
            const { lab, host } = ctx;
            const tls = need(ctx, "tls");
            const ingress = need(ctx, "ingress");
            const name = `${host.name}/rancher`;
            const server = new RancherServer(name, {
                cluster: need(ctx, "kubernetes"),
                chart: profileChart("rancher", host, lab, settings.version),
                values: chartValuesWithSecrets(settings.values),
                hostname: String(profileChart("rancher", host, lab).lockedValues.hostname),
                adminPassword: secretString(settings.adminPassword),
                // A CA nothing trusts (Let's Encrypt staging): agents (imported Harvesters, downstream
                // nodes) trust Rancher through its roots, and the engine skips verifying it.
                insecure: !!lab.acme?.ca,
                privateCa: lab.acme?.ca,
                settings: settings.settings ?? {},
                features: settings.features,
                timeoutSeconds: lab.timeouts.rancherReady,
            }, { dependsOn: [...tls.ready, ...ingress.ready, ...(ctx.outputs["gateway-api"]?.ready ?? []), ...need(ctx, "secret-propagation").ready] });
            const rancher = server.access;

            const plugins = settings.plugins ?? lab.plugins.default;
            new UiPlugins(`${name}/plugins`, {
                rancher,
                repo: lab.plugins.repo,
                plugins: Array.isArray(plugins)
                    ? Object.fromEntries(plugins.map(p => [p, lab.plugins.versions[p]])) // names checked by the resolver
                    : plugins,
                timeoutSeconds: lab.timeouts.uiPlugin,
            });

            // The repos' secrets live on this cluster too (in Rancher's namespaces): after Rancher.
            const objects = ctx.hostObjects(rancher.cluster, [...rancher.ready, ...(ctx.outputs["downstream-secrets"]?.ready ?? [])]);
            new Fleet(`${name}/fleet`, {
                rancher,
                fleet: lab.fleet[host.name],
                after: objects?.resources,
                timeoutSeconds: lab.timeouts.resourceReady,
            });
            return { rancher };
        },
    },

    hauler: {
        build(ctx, settings) {
            const { lab, host } = ctx;
            // A certificate from the lab's ACME server (the resolver requires tls.cloudflare for one); plain HTTP for tls.acme: none.
            const tls = lab.acme && lab.tls.cloudflare
                ? { lego: download("lego", lab), server: lab.acme.url, email: lab.tls.email, cloudflareToken: secretString(lab.tls.cloudflare) }
                : undefined;
            if (!tls) pulumi.log.warn(`host ${host.name}: tls.acme is none; Hauler's registry speaks plain HTTP`);
            const registry = new HaulerRegistry(`${host.name}/hauler`, {
                host: ctx.access,
                hauler: download("hauler", lab, settings.version),
                manifests: Object.fromEntries(settings.manifests.map(m => [`${m}.yaml`, lab.haulManifests[m]])), // names checked by the resolver
                port: settings.port,
                fileserverPort: settings.fileserverPort,
                tls,
                after: ctx.ready,
                timeoutSeconds: lab.timeouts.haulerSync,
            }, { deletedWith: ctx.machine });
            return { registry: { ready: [registry.setup] } };
        },
    },
    "mlm-server": notBuiltYet("mlm-server", "M6"),
    "mlm-client": notBuiltYet("mlm-client", "M6"),
};

type AnyBuilder = ProfileBuilder<ProfileName>;

/**
 * For a profile with a chart and no builder: install the chart once the profiles it requires or
 * uses are ready, and report the release under each of its capabilities.
 */
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
    }, { aliases: (p.aliases ?? []).map(type => ({ type })) });
    const done = [...before, component.release];
    done.push(...installEntries(lab, target, name, cluster, range(main + 1, p.entries.length), [component.release]));
    // Its objects after its charts; it's ready once the last one is.
    const objects = target.chartValues[name]?.objects ?? [];
    if (objects.length > 0) done.push(...applyObjects(lab, `${target.name}/${name}`, cluster, objects, component, done.slice(-1)));
    return done;
}

function chartProfileBuilder(name: string): AnyBuilder {
    return {
        build(ctx, settings) {
            const { lab, host } = ctx;
            const p = lab.profileCharts[name];
            const outputs = ctx.outputs as Record<string, { ready?: pulumi.Resource[] } | undefined>;
            const after = [...p.waitFor.flatMap(c => outputs[c]?.ready ?? []), ...ctx.before];
            const s = settings as { version?: string; values?: Record<string, unknown> };
            // On a host, the build loop installs the entries before its own chart (ctx.before) and
            // after it: here its chart and its objects.
            const main = p.entries.findIndex(e => e.kind === "chart" && e.main);
            if (main < 0) {
                const done = installEntries(lab, host, name, need(ctx, "kubernetes"), p.entries.map((_, i) => i), after);
                return Object.fromEntries(p.provides.map(c => [c, { ready: done.slice(-1) }])) as HostOutputs;
            }
            const cluster = need(ctx, "kubernetes");
            const component = new ChartProfile(`${host.name}/${name}`, {
                cluster,
                chart: withSecrets(profileChart(name, host, lab, s.version)),
                values: chartValuesWithSecrets(s.values),
                after,
            }, { aliases: (p.aliases ?? []).map(type => ({ type })) });
            const done: pulumi.Resource[] = [component.release];
            const objects = host.chartValues[name]?.objects ?? [];
            if (objects.length > 0) done.push(...applyObjects(lab, `${host.name}/${name}`, cluster, objects, component, done.slice(-1)));
            return Object.fromEntries(p.provides.map(c => [c, { ready: done.slice(-1) }])) as HostOutputs;
        },
    };
}

/**
 * Install some of a profile's `charts` entries, one after the other (skipping those whose `when` is
 * false): a manifest with its `{version}` and vars filled in, or a chart with its rendered values.
 */
/** Where a profile's entries go: a host, or a downstream cluster (`name` prefixes the resources). */
type ChartTarget = { name: string; chartValues: ResolvedHost["chartValues"] };
/** The cluster a profile's charts and objects go on: its kubeconfig for what the provider can't check (admission). */
type ChartCluster = Pick<ClusterAccess, "provider" | "deletedWith"> & { kubeconfig?: pulumi.Input<string> };

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
    for (const { name, object, admitted, wait } of objects) {
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
        const opts: pulumi.CustomResourceOptions = { parent, provider: cluster.provider, deletedWith: cluster.deletedWith, dependsOn: before };
        // Core kinds (apiVersion v1, no group) have classes of their own (k8s.core.v1.Secret); the rest are custom resources.
        const Core = apiVersion === "v1" ? (k8s.core.v1 as unknown as Record<string, new (n: string, a: object, o: pulumi.CustomResourceOptions) => pulumi.CustomResource>)[kind] : undefined;
        if (apiVersion === "v1" && !Core) throw new Error(`${prefix}/${name}: no core kind ${kind}`);
        made.push(Core ? new Core(`${prefix}/${name}`, args, opts) : new k8s.apiextensions.CustomResource(`${prefix}/${name}`, { apiVersion, kind, ...args }, opts));
    }
    return made;
}

/** A profile's builder: its own, or the generic one for a chart-only profile. */
export function builderOf(lab: ResolvedLab, name: string): AnyBuilder {
    const builder = BUILDERS[name as ProfileName] as unknown as AnyBuilder | undefined;
    if (builder) return builder;
    if (lab.profileCharts[name]) return chartProfileBuilder(name);
    throw new Error(`profile ${name} has neither a builder in program/profiles.ts nor a chart`);
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
    const outputs: HostOutputs = {};
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
        const waitFor = (lab.profileCharts[name]?.waitFor ?? []).flatMap(c => (outputs as Record<string, { ready?: pulumi.Resource[] } | undefined>)[c]?.ready ?? []);
        const before = cluster && main > 0 ? installEntries(lab, host, name, cluster, range(0, main), waitFor) : [];
        const built = builderOf(lab, name).build({ lab, host, access, ready, machine, harvester, outputs, hostObjects, before }, settingsOf(host, name)) ?? {};
        Object.assign(outputs, built);
        if (cluster && main >= 0 && main < entries.length - 1) {
            const builtReady = Object.values(built).flatMap(v => (v && "ready" in v ? (v.ready as pulumi.Resource[]) : []));
            installEntries(lab, host, name, cluster, range(main + 1, entries.length), builtReady);
        }
    }
    // Not asked for by a profile: after everything the host's profiles made.
    if (outputs.kubernetes) {
        const cluster = outputs.kubernetes;
        const allReady = Object.values(outputs).flatMap(v => (v && "ready" in v ? v.ready : []));
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
