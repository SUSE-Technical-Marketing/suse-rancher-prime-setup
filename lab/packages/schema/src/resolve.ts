import { Diagnostics } from "./diagnostics";
import { CatalogLayer, catalogValues, ResolvedAcmeServer, ResolvedComponent, ResolvedPlugins, Timeouts } from "./catalog";
import { ResolvedFleet } from "./fleet";
import { ResolvedObject } from "./objects";
import { ResolvedOs } from "./os";
import type { TimeoutName } from "./primitives";
import { Profiles } from "./profiles";
import type { ResolvedClusterOfType } from "./clusters";
import { AwsCredentials, Credentials, LabFile, PersonalConfig } from "./schema";
import { type SecretShape } from "./secrets";
import { stackPackFile } from "./stackpack-files";
import { createResolution } from "./phases/context";
import { resolveAwsSites } from "./phases/aws-sites";
import { placeHostCharts } from "./phases/charts";
import { checkProfiles, checkTopLevel, resolveImages } from "./phases/checks";
import { resolveClusterProfiles, resolveDownstream } from "./phases/downstream";
import { resolveFleetProfiles, resolveFleetRepos } from "./phases/fleet";
import { resolveHarvesterProfiles } from "./phases/harvester-profiles";
import { resolveHarvesters } from "./phases/harvesters";
import { renderHostProfiles, resolveHosts } from "./phases/hosts";
import { createLabObjects, placeLabObjects } from "./phases/objects";

export { MACHINE_CLOUD_INIT_KEYS } from "./phases/hosts";
export { inCidr, nthAddress, toInt } from "./net";

// ---------------------------------------------------------------------------------------------
// Resolved model: plain JSON, handed to the Pulumi program as stack config. Secret templates
// ("{{ secrets.x }}") stay as they are; the program renders them with the values it receives separately.

export interface ResolvedNetwork {
    /** `untagged` or `vlan<id>`. */
    name: string;
    vlanId?: number;
    dhcp?: { cidr: string; server: string; gateway: string; range: [string, string]; dns?: string[] };
    /** Its subnet, gateway and DNS servers, for VMs with fixed addresses: from `dhcp`, or the network's own. */
    subnet?: { cidr: string; gateway: string; dns: string[] };
    /** Harvester load-balancer IP pool for guest clusters' LoadBalancer services. */
    loadBalancer?: { cidr: string; gateway: string; range: [string, string] };
}

export type ResolvedImageSource = { kind: "url"; url: string } | { kind: "file"; path: string };

export interface ResolvedHarvester {
    name: string;
    url: string;
    credentials: Credentials;
    insecure: boolean;
    clusterNetwork: string;
    storageClass: { name: string; replicas: number; parameters: Record<string, string> };
    /** Profiles on the Harvester itself (those that target Harvesters), their settings checked. */
    profiles: Record<string, Record<string, unknown>>;
    /** By ChartProfile on it (an add-on): its chart's values and its objects, templates rendered. */
    chartValues: Record<string, RenderedProfile>;
    networks: ResolvedNetwork[];
    defaultNetwork: string;
    /** One image per OS used by hosts or downstream pools on this Harvester. */
    images: { os: string; source: ResolvedImageSource }[];
}

export interface ResolvedAwsSite {
    name: string;
    region: string;
    credentials: AwsCredentials;
    vpcCidr: string;
    /** A public subnet in each, in order: the first is where pools without a `zone` go. */
    zones: { letter: string; /** `eu-west-1a` */ az: string; cidr: string }[];
    /** Seconds the lab is meant to live (tagged, not enforced). */
    ttl?: number;
}

/** One entry of a profile's `charts` on a host, its templates rendered. */
export interface RenderedChartEntry {
    values: Record<string, unknown>;
    lockedValues: Record<string, unknown>;
    /** Whether it's installed on this host (`when`). */
    install: boolean;
    /** Another version than the catalog's, when its `version` template gives one. */
    version?: string;
    vars: Record<string, string>;
    /** Its registry's login (its HelmChart's `credentials` input), a secret template or a map. */
    credentials?: Credentials;
    /** What must exist (or have a condition True) on the cluster before it's installed. */
    waitFor?: { path: string; condition?: string }[];
}

/** One of a profile's `objects` on a host (only those whose `when` holds), its templates rendered. */
export interface RenderedObject {
    /** Its name in the lab's state, under the profile. */
    name: string;
    object: Record<string, unknown>;
    /** Wait for the API server to admit it first (a webhook). */
    admitted?: boolean;
    /** Its names in the lab's state before: kept, not replaced. */
    aliases?: string[];
    wait?: { condition: string; timeout: TimeoutName };
}

/** A fixed address, set in the VM itself (no DHCP): with its prefix, gateway and DNS servers. */
export interface FixedAddress { address: string; prefix: number; gateway: string; dns: string[] }

/** How the program wires a profile in (any profile, chart or code): what it provides and waits for. */
export interface ProfileWiring {
    /** Its capabilities (its own name and `provides`): the build loop reports what it made under each it provides on a host. */
    provides: string[];
    /** Capabilities whose providers it's built after (`requires`, `uses`, `requiresWhen`). */
    waitFor: string[];
    /** The KubernetesDistribution it installs (`k3s`, `rke2`): it gets the Kubernetes builder. */
    distribution?: string;
}

/** A profile's charts and objects on one host, cluster or Harvester, templates rendered (§17). */
export interface RenderedProfile {
    entries: RenderedChartEntry[];
    objects: RenderedObject[];
    /** The StackPacks it wants on the SUSE Observability instance it sends to (`observerStackPacks`). */
    stackPacks?: { observer: string; adminToken: string; install: string[] };
    /** What its own chart's resource was created as before (`aliases`): kept, not replaced. */
    aliases: { type?: string; name?: string }[];
}

/** How a profile installs its chart: the HelmChart and namespace (its values are per host: `chartValues`). */
export interface ProfileChart {
    /** What it installs, in order; `main` marks its own chart (the lab's `values`, the `version` setting). */
    entries: ({ kind: "chart"; chart: string; namespace: string; main: boolean } | { kind: "manifest"; manifest: string })[];
}

export interface ResolvedChartPlacement {
    name: string;
    chart: string;
    repo?: string;
    version: string;
    namespace: string;
    values: Record<string, unknown>;
}

interface ResolvedHostBase {
    name: string;
    os: string;
    /** Profile name -> its settings, checked against the profile's catalog schema (defaults applied). */
    profiles: Profiles;
    /** The host's profiles in build order: each after the profiles it requires. */
    profileOrder: string[];
    /** What the host's profiles provide: their names plus `provides`. */
    capabilities: string[];
    /** Capability -> the profiles on this host providing it: a profile's `fallback` only when no other does. */
    providers: Record<string, string[]>;
    /** Catalog HelmCharts installed on the host's cluster after its profiles (§17). */
    charts: ResolvedChartPlacement[];
    /** By chart profile on this host: its Profile's `values` and `lockedValues`, templates rendered. */
    chartValues: Record<string, RenderedProfile>;
    /** By capability: what the profile providing it on this host declares under `outputs`. */
    outputs: Record<string, Record<string, unknown>>;
    /** DNS name the host is reached at. */
    fqdn: string;
    /** It runs Kubernetes (a k3s / RKE2 profile, or a metal cluster's node): its OS profile's `kubernetes` part applies. */
    kubernetes: boolean;
}

export interface ResolvedHarvesterHost extends ResolvedHostBase {
    kind: "harvester";
    harvester: string;
    cpu: number;
    memory: string;
    disk: string;
    /** A network of its Harvester document (`vlan20`), or `namespace/name` of one already on the Harvester. */
    network: string;
    macAddress?: string;
    /** Its fixed address, set in the VM (cloud-init's network config): address, prefix, gateway, DNS servers. */
    ip?: FixedAddress;
}

export interface ResolvedSshHost extends ResolvedHostBase {
    kind: "ssh";
    address: string;
    user: string;
}

export type ResolvedHost = ResolvedHarvesterHost | ResolvedSshHost;

/** A downstream cluster; a Harvester or EC2 one's pools with their machine size filled in, an EKS one's version and node groups. */
/** A downstream cluster's ChartProfiles, as a host's profiles are resolved. */
export interface ResolvedClusterProfiles {
    /** Name -> its settings, defaults applied. */
    profiles: Profiles;
    /** Build order: each after the profiles it requires. */
    order: string[];
    /** By profile: its charts' values and its objects, templates rendered. */
    chartValues: Record<string, RenderedProfile>;
}

export type ResolvedDownstream = {
    name: string;
    /**
     * Its `profiles`, checked and rendered: the engine installs them once the cluster is ready (a
     * ChartProfile's charts and objects; a Profile with code, one that targets clusters, by its builder).
     */
    chartProfiles?: ResolvedClusterProfiles;
    /** What its Fleet profiles say Fleet installs, by capability (`suse-observability: { url }`), rendered. */
    fleetOutputs?: Record<string, Record<string, string>>;
    /** What its Fleet profiles provide: their names and `provides` (`gpu`). */
    fleetCapabilities?: string[];
} & ResolvedClusterOfType;

export interface ResolvedLab {
    name: string;
    domain: string;
    /** The Lab document's `vars`, references rendered; secrets still templates. */
    vars: Record<string, unknown>;
    tls: LabFile["tls"];
    /** The AcmeServer `tls.acme` names; none for `tls.acme: none`. */
    acme?: ResolvedAcmeServer;
    ssh?: { user: string; publicKey: string; privateKey: string };
    /** Everything the lab can install and its version, from the catalog (§16). */
    components: Record<string, ResolvedComponent>;
    /** For each profile with a chart: which chart, its namespace, default and locked values (§17). */
    profileCharts: Record<string, ProfileChart>;
    /** Every profile in the catalog: what it provides and waits for, and its distribution (§7.6). */
    profiles: Record<string, ProfileWiring>;
    /** The UI plugin repository and default plugin set, from the catalog. */
    plugins: ResolvedPlugins;
    harvesters: ResolvedHarvester[];
    awsSites: ResolvedAwsSite[];
    hosts: ResolvedHost[];
    downstream: ResolvedDownstream[];
    /** Only the OS profiles the lab actually uses. */
    os: Record<string, ResolvedOs>;
    /** Fleet configuration per host running the `rancher` profile (DESIGN.md §16.3). */
    fleet: Record<string, ResolvedFleet>;
    /** Secrets and configmaps to create, each on its cluster (§16.6). */
    objects: ResolvedObject[];
    /** Objects (or keys of them) left out, and what they wait for. */
    skippedObjects: { what: string; missing: string[] }[];
    /** Every secret the lab needs, with the shape its value must have. */
    secrets: Record<string, SecretShape>;
    /** How long the engine waits for each step, in seconds (the catalog's Defaults). */
    timeouts: Timeouts;
    /** Images the engine runs itself (Defaults `images`). */
    images: { kubectl: string };
    /** The HaulManifests the lab's profiles name, rendered as Hauler content documents. */
    haulManifests: Record<string, string>;
    /** StackPacks on the lab's SUSE Observability instances, each once per instance (its profiles' `observerStackPacks`). */
    stackPacks: ResolvedStackPack[];
    /** Profiles the lab uses that the engine doesn't build yet (`status: planned`): `lab up` refuses the lab. */
    planned: string[];
}

// ---------------------------------------------------------------------------------------------

export interface ResolveInput {
    lab: LabFile;
    labSource: string;
    personal: PersonalConfig;
    personalSource: string;
    /** The catalog's layers, in order: built-in, the personal config's documents, the lab file's. */
    catalogLayers: CatalogLayer[];
    /** Directories that relative `file:` paths in the lab file / personal config resolve against. */
    labDir: string;
    personalDir: string;
    home: string;
    fs: { exists(p: string): boolean; read(p: string): string };
}

/** A StackPack on a SUSE Observability instance of the lab, while any profile wants it (DESIGN.md §9.6). */
export interface ResolvedStackPack {
    /** The downstream cluster running the instance, and the instance (its Fleet profile's `url`). */
    observer: string;
    url: string;
    name: string;
    stackPack: Extract<ResolvedComponent, { kind: "StackPack" }>;
    /** Built from source: its .sts, built by `lab stackpacks` (`up` checks it's there first). */
    file?: string;
    /** A template (a secret's): the first wanting profile's. */
    adminToken: string;
    /** What wants it, `<host, cluster or Harvester>/<profile>`, in the lab's order. */
    wantedBy: string[];
}

/** Every profile's `observerStackPacks`, by instance and StackPack. */
function collectStackPacks(rendered: [string, Record<string, RenderedProfile> | undefined][], downstream: ResolvedDownstream[], components: Record<string, ResolvedComponent>): ResolvedStackPack[] {
    const byKey = new Map<string, ResolvedStackPack>();
    for (const [on, profiles] of rendered) {
        for (const [profile, r] of Object.entries(profiles ?? {})) {
            if (!r.stackPacks) continue;
            const url = downstream.find(d => d.name === r.stackPacks!.observer)?.fleetOutputs?.["suse-observability"]?.url;
            if (url === undefined) continue;
            for (const name of r.stackPacks.install) {
                const stackPack = components[name];
                if (stackPack?.kind !== "StackPack") continue;
                const key = `${r.stackPacks.observer}/${name}`;
                const file = stackPack.archive && stackPack.version ? { file: stackPackFile(name, stackPack.version) } : {};
                const entry = byKey.get(key) ?? { observer: r.stackPacks.observer, url, name, stackPack, ...file, adminToken: r.stackPacks.adminToken, wantedBy: [] };
                entry.wantedBy.push(`${on}/${profile}`);
                byKey.set(key, entry);
            }
        }
    }
    return [...byKey.values()];
}

export interface ResolveResult {
    lab?: ResolvedLab;
    diagnostics: Diagnostics;
}


/**
 * A lab file, its catalog and the personal config, resolved: checked against each other and filled in,
 * everything the program builds from (DESIGN.md §7.1). Its phases (phases/) run in this order, each
 * on what the ones before it resolved; their errors and warnings come in that order.
 */
export function resolveLab(input: ResolveInput, diags = new Diagnostics()): ResolveResult {
    const r = createResolution(input, diags);
    resolveHarvesters(r);
    resolveAwsSites(r);
    resolveHosts(r);
    createLabObjects(r);
    resolveFleetRepos(r);
    resolveDownstream(r);
    resolveFleetProfiles(r);
    renderHostProfiles(r);
    placeHostCharts(r);
    resolveClusterProfiles(r);
    resolveHarvesterProfiles(r);
    checkProfiles(r);
    placeLabObjects(r);
    resolveImages(r);
    const ssh = checkTopLevel(r);

    const { lab, acme, catalog, harvesters, awsSites, hosts, downstream, usedOs, fleet, objects, secrets, usedHaulManifests, renderedHaul, plannedProfiles } = r;
    if (!diags.ok) return { diagnostics: diags };
    return {
        diagnostics: diags,
        lab: {
            name: lab.lab,
            domain: lab.domain,
            vars: lab.vars,
            tls: lab.tls,
            ...(acme ? { acme } : {}),
            ssh,
            components: catalogValues(catalog.components),
            profileCharts: Object.fromEntries(Object.values(catalog.profiles).filter(p => p.charts?.length || p.objects?.length).map(p => [p.name, {
                entries: (p.charts ?? []).map((e, i) => e.chart !== undefined
                    ? { kind: "chart" as const, chart: e.chart, namespace: e.namespace!, main: i === p.charts!.findIndex(x => x.chart !== undefined) }
                    : { kind: "manifest" as const, manifest: e.manifest! }),
            }])),
            profiles: Object.fromEntries(Object.values(catalog.profiles).map(p => [p.name, {
                provides: [p.name, ...(p.provides ?? [])],
                waitFor: [...new Set([...(p.requires ?? []), ...(p.uses ?? []), ...(p.requiresWhen ?? []).map(r => r.capability)])],
                ...(p.distribution ? { distribution: p.distribution } : {}),
            }])),
            plugins: catalog.plugins.value,
            harvesters: [...harvesters.values()],
            awsSites: [...awsSites.values()],
            hosts: [...hosts.values()],
            downstream,
            os: usedOs,
            fleet,
            objects: objects.objects,
            skippedObjects: objects.skipped,
            secrets,
            timeouts: catalog.defaults.value.timeouts,
            images: catalog.defaults.value.images,
            haulManifests: Object.fromEntries([...usedHaulManifests].sort().map(n => [n, renderedHaul[n]])),
            stackPacks: collectStackPacks([
                ...[...hosts.values()].map(h => [h.name, h.chartValues] as [string, Record<string, RenderedProfile> | undefined]),
                ...downstream.map(d => [d.name, d.chartProfiles?.chartValues] as [string, Record<string, RenderedProfile> | undefined]),
                ...[...harvesters.values()].map(h => [h.name, h.chartValues] as [string, Record<string, RenderedProfile> | undefined]),
            ], downstream, catalogValues(catalog.components) as Record<string, ResolvedComponent>),
            planned: [...plannedProfiles].sort(),
        },
    };
}
