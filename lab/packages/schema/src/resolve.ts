import * as path from "node:path";
import { Diagnostics } from "./diagnostics";
import { CatalogLayer, catalogValues, ResolvedAcmeServer, ResolvedComponent, ResolvedPlugins, resolveCatalog, Timeouts } from "./catalog";
import { FleetSettings, ResolvedFleet, resolveFleet } from "./fleet";
import { createObjects, ObjectTarget, Placement, placementOf, ResolvedObject } from "./objects";
import { docAt } from "./documents";
import { isTemplate, renderTemplates, TemplateContext } from "./templates";
import { checkSecretTemplate, describeShape, mapShape, mergeShapes, type SecretShape, usesSecrets } from "./secrets";
import { ResolvedOs } from "./os";

/** cloud-config keys an existing machine (no user data) gets, over SSH instead (packages are always refreshed first). */
export const MACHINE_CLOUD_INIT_KEYS = ["packages", "runcmd", "package_update"];
import { Profiles } from "./profiles";
import { activeRequirements, blocksMetalClusterNode, checkHostProfiles, describeCapability, hostCapabilities, profileBuildOrder } from "./profiles/rules";
import {
    AWS_CREDENTIAL_FIELDS, AwsCredentials, Credentials, DownstreamInput, durationSeconds, HarvesterInput, ImageSource, LabFile, NODE_ROLES,
    PersonalConfig, VersionValue,
} from "./schema";

// ---------------------------------------------------------------------------------------------
// Resolved model: plain JSON, handed to the Pulumi program as stack config. Secret templates
// ("{{ secrets.x }}") stay as they are; the program renders them with the values it receives separately.

export interface ResolvedNetwork {
    /** `untagged` or `vlan<id>`. */
    name: string;
    vlanId?: number;
    dhcp?: { cidr: string; server: string; gateway: string; range: [string, string]; dns?: string[] };
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
    dns?: HarvesterInput["dns"];
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
}

/** How a profile installs its chart: the HelmChart and namespace (its values are per host: `chartValues`). */
export interface ProfileChart {
    /** What it installs, in order; `main` marks its own chart (the lab's `values`, the `version` setting). */
    entries: ({ kind: "chart"; chart: string; namespace: string; main: boolean } | { kind: "manifest"; manifest: string })[];
    /** Its capabilities (its own name and `provides`): a chart-only profile reports its release under each. */
    provides: string[];
    /** Capabilities whose providers it installs after (`requires`, `uses`, `requiresWhen`). */
    waitFor: string[];
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
    chartValues: Record<string, { entries: RenderedChartEntry[] }>;
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
    network: string;
    macAddress?: string;
}

export interface ResolvedSshHost extends ResolvedHostBase {
    kind: "ssh";
    address: string;
    user: string;
}

export type ResolvedHost = ResolvedHarvesterHost | ResolvedSshHost;

type HarvesterDownstreamInput = Extract<DownstreamInput, { type: "harvester" }>;
type Ec2DownstreamInput = Extract<DownstreamInput, { type: "ec2" }>;
/** An EC2 pool with its defaults filled in. */
export type ResolvedEc2Pool = Ec2DownstreamInput["pools"][number] & { instanceType: string; disk: string; zone: string };
type EksDownstreamInput = Extract<DownstreamInput, { type: "eks" }>;
/** An EKS node group with its defaults filled in. */
export type ResolvedEksNodeGroup = EksDownstreamInput["nodeGroups"][number] & { min: number; max: number; instanceType: string; disk: string; zones: string[] };
/** A downstream cluster; a Harvester or EC2 one's pools with their machine size filled in, an EKS one's version and node groups. */
export type ResolvedDownstream = { name: string } & (
    | Exclude<DownstreamInput, { type: "harvester" | "ec2" | "eks" }>
    | (Omit<EksDownstreamInput, "nodeGroups" | "version"> & { version: string; nodeGroups: ResolvedEksNodeGroup[] })
    | (Omit<HarvesterDownstreamInput, "pools"> & { pools: (HarvesterDownstreamInput["pools"][number] & { cpu: number; memory: string; disk: string })[] })
    | (Omit<Ec2DownstreamInput, "pools"> & { pools: ResolvedEc2Pool[] })
);

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

export interface ResolveResult {
    lab?: ResolvedLab;
    diagnostics: Diagnostics;
}

export function resolveLab(input: ResolveInput, diags = new Diagnostics()): ResolveResult {
    const { lab, labSource: L, personal, personalSource: P } = input;
    const secrets: Record<string, SecretShape> = {};

    const expand = (p: string, baseDir: string) => {
        const home = p === "~" || p.startsWith("~/") ? path.join(input.home, p.slice(1)) : p;
        return path.resolve(baseDir, home);
    };

    const needSecret = (name: string, shape: SecretShape, source: string, at: string) => {
        const existing = secrets[name];
        const merged = existing ? mergeShapes(existing, shape) : shape;
        if (!merged) {
            diags.error(source, at, `secret "${name}" is used both as ${describeShape(existing!)} and as ${describeShape(shape)}`);
            return;
        }
        secrets[name] = merged;
    };

    /** A template that may use secrets: report what's wrong with it, register the secrets it uses. */
    const useTemplate = (template: string, shape: SecretShape, source: string, at: string, vars?: Record<string, unknown>) => {
        const { uses, error } = checkSecretTemplate(template, shape, vars);
        if (error) diags.error(source, at, error);
        for (const u of uses) needSecret(u.name, u.shape, source, at);
    };

    const PLAIN = "secret value is written in the lab file; use a secret (\"{{ secrets.name }}\") before sharing it";

    /** A secret field: a template over `secrets`, or a plain value (a warning in the lab file). */
    const useSecretOrString = (v: string | undefined, source: string, at: string) => {
        if (v === undefined) return;
        if (isTemplate(v)) useTemplate(v, "string", source, at);
        else if (source === L) diags.warning(source, at, PLAIN);
    };

    /** Credentials: one secret ("{{ secrets.harbor }}"), or a username with a password. */
    const useCredentials = (creds: Credentials, source: string, at: string) => {
        if (typeof creds === "string") {
            if (isTemplate(creds)) useTemplate(creds, "credentials", source, at);
            else diags.error(source, at, "credentials are one secret (\"{{ secrets.name }}\") or { username, password }");
            return;
        }
        if (isTemplate(creds.username)) useTemplate(creds.username, "string", source, `${at}.username`);
        useSecretOrString(creds.password, source, `${at}.password`);
    };

    /** AWS keys: one secret holding `accessKey` and `secretKey`, or the two fields. */
    const useAwsCredentials = (creds: AwsCredentials, source: string, at: string) => {
        if (typeof creds === "string") {
            if (isTemplate(creds)) useTemplate(creds, mapShape(AWS_CREDENTIAL_FIELDS), source, at);
            else diags.error(source, at, `AWS credentials are one secret ("{{ secrets.name }}") or { ${AWS_CREDENTIAL_FIELDS.join(", ")} }`);
            return;
        }
        for (const f of AWS_CREDENTIAL_FIELDS) useSecretOrString(creds[f], source, `${at}.${f}`);
    };

    /** Register the secrets in free-form values (chart values): every string that uses `secrets`. */
    const walkRefs = (value: unknown, at: string): void => {
        if (typeof value === "string") { if (usesSecrets(value)) useTemplate(value, "string", L, at); }
        else if (Array.isArray(value)) value.forEach((v, i) => walkRefs(v, `${at}[${i}]`));
        else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walkRefs(v, `${at}.${k}`);
    };

    // --- Catalog: versions and OS profiles ------------------------------------------------------
    const catalog = resolveCatalog([
        ...input.catalogLayers,
    ], diags);
    const allOs = catalogValues(catalog.os);
    const acme = lab.tls.acme === "none" ? undefined : catalog.acme[lab.tls.acme]?.value;
    if (lab.tls.acme !== "none" && !acme) {
        diags.error(L, "tls.acme", `no AcmeServer "${lab.tls.acme}"; known: ${[...Object.keys(catalog.acme).sort(), "none"].join(", ")}`);
    }
    const usedOs: Record<string, ResolvedOs> = {};
    const useOs = (name: string, at: string): ResolvedOs | undefined => {
        const os = allOs[name];
        if (!os) {
            diags.error(L, at, `unknown OS profile "${name}"; known: ${Object.keys(allOs).sort().join(", ") || "none"}`);
            return undefined;
        }
        if (!usedOs[name]) {
            usedOs[name] = os;
            // Rendered for real by the program, with the secrets' values; this checks the templates and
            // finds the secrets they use (a registration code, say).
            const vars = { lab: { name: lab.lab, domain: lab.domain, vars: lab.vars } };
            const walk = (value: unknown, at: string): void => {
                if (typeof value === "string") { if (isTemplate(value)) useTemplate(value, "string", `OS profile ${name}`, at, vars); }
                else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`));
                else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`);
            };
            walk(os.cloudInit, "cloudInit");
            walk(os.harvester, "harvester.cloudInit");
            walk(os.kubernetes, "kubernetes.cloudInit");
        }
        return os;
    };

    // --- Harvesters --------------------------------------------------------------------------
    const harvesters = new Map<string, ResolvedHarvester>();
    const hvDefaults = catalog.defaults.value.harvester;
    const vmDefaults = catalog.defaults.value.vm;
    for (const [name, h] of Object.entries(lab.harvesters)) {
        const at = `harvesters.${name}`;
        const mine = personal.harvesters[name] ?? {};
        const url = h.url ?? mine.url;
        const credentials = h.credentials ?? mine.credentials;
        if (!url) diags.error(L, `${at}.url`, `missing; set it here or in the personal config under harvesters.${name}.url`);
        if (!credentials) {
            diags.error(L, `${at}.credentials`, `missing; set it here or in the personal config under harvesters.${name}.credentials`);
        } else {
            useCredentials(credentials, h.credentials ? L : P, h.credentials ? `${at}.credentials` : `harvesters.${name}.credentials`);
        }
        if (h.dns?.credentials) useCredentials(h.dns.credentials, L, `${at}.dns.credentials`);

        const withServer = (dhcp: typeof h.networks.untagged.dhcp, at: string) => {
            if (!dhcp) return undefined;
            const server = dhcp.server ?? nthAddress(dhcp.cidr, 2);
            const [base, bits] = dhcp.cidr.split("/");
            if (nthAddress(dhcp.cidr, 0) !== base) diags.error(L, `${at}.cidr`, `${dhcp.cidr} isn't the start of its range; use ${nthAddress(dhcp.cidr, 0)}/${bits}`);
            const last = nthAddress(dhcp.cidr, 2 ** (32 - Number(bits)) - 1);
            const named = [["server", server], ["gateway", dhcp.gateway], ["range[0]", dhcp.range[0]], ["range[1]", dhcp.range[1]]] as const;
            for (const [field, ip] of named) {
                if (!inCidr(ip, dhcp.cidr)) diags.error(L, `${at}.${field}`, `${ip} is outside ${dhcp.cidr}`);
                else if (ip === nthAddress(dhcp.cidr, 0)) diags.error(L, `${at}.${field}`, `${ip} is the network's own address`);
                else if (ip === last) diags.error(L, `${at}.${field}`, `${ip} is the network's broadcast address`);
            }
            if (toInt(dhcp.range[0]) > toInt(dhcp.range[1])) diags.error(L, `${at}.range`, "start is after end");
            else for (const [what, ip] of [["gateway", dhcp.gateway], ["DHCP server", server]] as const) {
                if (toInt(ip) >= toInt(dhcp.range[0]) && toInt(ip) <= toInt(dhcp.range[1])) diags.error(L, `${at}.range`, `contains the ${what} ${ip}`);
            }
            if (server === dhcp.gateway) {
                diags.error(L, `${at}.server`, dhcp.server
                    ? `${server} is also the gateway; the DHCP server needs an address of its own`
                    : `the DHCP server defaults to ${server}, which is the gateway; set server to a free address`);
            }
            return { ...dhcp, server };
        };
        type PoolInput = NonNullable<typeof h.networks.untagged.loadBalancer>;
        const withPool = (pool: PoolInput | undefined, dhcp: ResolvedNetwork["dhcp"], poolAt: string): ResolvedNetwork["loadBalancer"] => {
            if (!pool) return undefined;
            const cidr = pool.cidr ?? dhcp?.cidr;
            const gateway = pool.gateway ?? dhcp?.gateway;
            if (!cidr || !gateway) {
                diags.error(L, poolAt, "needs cidr and gateway on a network without lab DHCP");
                return undefined;
            }
            pool.range.forEach((ip, i) => {
                if (!inCidr(ip, cidr)) diags.error(L, `${poolAt}.range[${i}]`, `${ip} is outside ${cidr}`);
            });
            if (toInt(pool.range[0]) > toInt(pool.range[1])) diags.error(L, `${poolAt}.range`, "start is after end");
            if (dhcp && toInt(pool.range[0]) <= toInt(dhcp.range[1]) && toInt(dhcp.range[0]) <= toInt(pool.range[1])) {
                diags.error(L, `${poolAt}.range`, `overlaps the DHCP range ${dhcp.range[0]}-${dhcp.range[1]}`);
            }
            for (const [what, ip] of [["gateway", gateway], ["DHCP server", dhcp?.server]] as const) {
                if (ip && toInt(ip) >= toInt(pool.range[0]) && toInt(ip) <= toInt(pool.range[1])) diags.error(L, `${poolAt}.range`, `contains the ${what} ${ip}`);
            }
            return { cidr, gateway, range: pool.range };
        };
        const untaggedDhcp = withServer(h.networks.untagged.dhcp, `${at}.networks.untagged.dhcp`);
        const networks: ResolvedNetwork[] = [{
            name: "untagged",
            dhcp: untaggedDhcp,
            loadBalancer: withPool(h.networks.untagged.loadBalancer, untaggedDhcp, `${at}.networks.untagged.loadBalancer`),
        }];
        const seenVlans = new Set<number>();
        h.networks.vlans.forEach((vlan, i) => {
            if (seenVlans.has(vlan.id)) diags.error(L, `${at}.networks.vlans[${i}].id`, `VLAN ${vlan.id} is defined twice`);
            seenVlans.add(vlan.id);
            const dhcp = withServer(vlan.dhcp, `${at}.networks.vlans[${i}].dhcp`);
            networks.push({
                name: `vlan${vlan.id}`, vlanId: vlan.id, dhcp,
                loadBalancer: withPool(vlan.loadBalancer, dhcp, `${at}.networks.vlans[${i}].loadBalancer`),
            });
        });
        const defaultNetwork = h.networks.default ?? "untagged";
        if (!networks.some(n => n.name === defaultNetwork)) {
            diags.error(L, `${at}.networks.default`, `unknown network "${defaultNetwork}"; known: ${networks.map(n => n.name).join(", ")}`);
        }

        harvesters.set(name, {
            name,
            url: url ?? "",
            credentials: credentials ?? { username: "", password: "" },
            insecure: h.insecure ?? mine.insecure ?? true,
            clusterNetwork: h.clusterNetwork ?? hvDefaults.clusterNetwork,
            storageClass: {
                name: h.storageClass?.name ?? hvDefaults.storageClass.name,
                replicas: h.storageClass?.replicas ?? hvDefaults.storageClass.replicas,
                parameters: { ...hvDefaults.storageClass.parameters, ...h.storageClass?.parameters },
            },
            dns: h.dns,
            networks,
            defaultNetwork,
            images: [],
        });
    }

    // --- AWS sites ---------------------------------------------------------------------------
    const awsSites = new Map<string, ResolvedAwsSite>();
    const awsDefaults = catalog.defaults.value.aws;
    for (const [name, s] of Object.entries(lab.awsSites)) {
        const at = `awsSites.${name}`;
        const mine = personal.awsSites[name] ?? {};
        const region = s.region ?? mine.region;
        const credentials = s.credentials ?? mine.credentials;
        if (!region) diags.error(L, `${at}.region`, `missing; set it here or in the personal config under awsSites.${name}.region`);
        if (!credentials) diags.error(L, `${at}.credentials`, `missing; set it here or in the personal config under awsSites.${name}.credentials`);
        else useAwsCredentials(credentials, s.credentials ? L : P, s.credentials ? `${at}.credentials` : `awsSites.${name}.credentials`);

        const vpcCidr = s.vpc?.cidr ?? awsDefaults.vpcCidr;
        const letters = s.zones ?? awsDefaults.zones;
        const prefix = Number(vpcCidr.split("/")[1]);
        // A subnet per zone, a sixteenth of the VPC each; AWS takes VPCs from /16 to /28, subnets down to /28.
        if (prefix < 16 || prefix > 24) diags.error(L, `${at}.vpc.cidr`, `must be a /16 to /24: each zone gets a sixteenth of it`);
        if (nthAddress(vpcCidr, 0) !== vpcCidr.split("/")[0]) diags.error(L, `${at}.vpc.cidr`, `${vpcCidr} isn't the start of its range; use ${nthAddress(vpcCidr, 0)}/${prefix}`);
        const seen = new Set<string>();
        letters.forEach((l, i) => {
            if (seen.has(l)) diags.error(L, `${at}.zones[${i}]`, `zone ${l} is listed twice`);
            seen.add(l);
        });
        const subnetSize = 2 ** (32 - prefix - 4);
        awsSites.set(name, {
            name,
            region: region ?? "",
            credentials: credentials ?? "",
            vpcCidr,
            zones: letters.map((letter, i) => ({ letter, az: `${region ?? ""}${letter}`, cidr: `${nthAddress(vpcCidr, i * subnetSize)}/${prefix + 4}` })),
            ...(s.ttl ? { ttl: durationSeconds(s.ttl) } : {}),
        });
    }

    const checkNetwork = (harvester: ResolvedHarvester, network: string | undefined, at: string): string => {
        const name = network ?? harvester.defaultNetwork;
        if (!harvester.networks.some(n => n.name === name)) {
            diags.error(L, at, `network "${name}" doesn't exist on harvester "${harvester.name}"; known: ${harvester.networks.map(n => n.name).join(", ")}`);
        }
        return name;
    };

    // OS name -> Harvester names it's needed on, to work out images afterwards.
    const imagesNeeded = new Map<string, Set<string>>();
    const needImage = (harvester: string, os: string) => {
        const set = imagesNeeded.get(harvester) ?? new Set<string>();
        // Variants (`extends`) without an image of their own share their parent's.
        set.add(allOs[os]?.image ?? os);
        imagesNeeded.set(harvester, set);
    };

    // --- Hosts -------------------------------------------------------------------------------
    const registry = catalog.profiles;
    /** A host's `profiles:`: known names, settings checked against each profile's schema. */
    const parseProfiles = (profiles: Record<string, Record<string, unknown>>, at: string): Profiles => {
        const result: Profiles = {};
        for (const [name, settings] of Object.entries(profiles)) {
            const def = registry[name];
            if (!def) {
                diags.error(L, `${at}.profiles`, `unknown profile "${name}"; known: ${Object.keys(registry).sort().join(", ")}`);
                continue;
            }
            const parsed = def.settings.safeParse(settings ?? {});
            if (parsed.success) result[name] = parsed.data as Record<string, unknown>;
            else diags.addZodError(L, parsed.error, [...at.split("."), "profiles", name]);
        }
        return result;
    };
    const hosts = new Map<string, ResolvedHost>();
    // Kubernetes on a host: its own distribution, or Rancher's as a metal cluster's node.
    const metalNodes = new Set(Object.values(lab.downstream).flatMap(d => (d.type === "metal" ? d.nodes.map(n => n.host) : [])));
    const runsKubernetes = (name: string, profiles: Record<string, unknown>) =>
        metalNodes.has(name) || Object.keys(profiles).some(p => registry[p]?.distribution);
    for (const [name, h] of Object.entries(lab.hosts)) {
        const at = `hosts.${name}`;
        useOs(h.os, `${at}.os`);

        if (h.on === "ssh") {
            for (const field of ["cpu", "memory", "disk", "network", "macAddress"] as const) {
                if (h[field] !== undefined) diags.error(L, `${at}.${field}`, `doesn't apply to an ssh host`);
            }
            if (!h.address) diags.error(L, `${at}.address`, "required for an ssh host (its DNS name or IP)");
            // An existing machine gets no user data: only its OS profile's Kubernetes packages and commands, over SSH.
            const kubernetes = runsKubernetes(name, h.profiles);
            const ignored = Object.keys(kubernetes ? allOs[h.os]?.kubernetes ?? {} : {}).filter(k => !MACHINE_CLOUD_INIT_KEYS.includes(k));
            if (ignored.length > 0) diags.warning(L, `${at}.os`, `OS profile ${h.os}: kubernetes.cloudInit.${ignored.join(", ")} only apply to VMs; a machine only gets its packages and runcmd, over SSH`);
            hosts.set(name, {
                kind: "ssh", name, os: h.os, profiles: parseProfiles(h.profiles, at), profileOrder: [], capabilities: [], providers: {}, charts: [], chartValues: {}, outputs: {}, kubernetes,
                address: h.address ?? "", fqdn: h.address ?? "", user: h.user ?? lab.ssh?.user ?? catalog.defaults.value.ssh.user,
            });
        } else {
            const harvester = harvesters.get(h.on);
            if (!harvester) {
                diags.error(L, `${at}.on`, `unknown Harvester "${h.on}"; known: ${[...harvesters.keys()].sort().join(", ") || "none (add a Harvester document)"}`);
                continue;
            }
            if (h.address !== undefined) diags.error(L, `${at}.address`, `only applies to ssh hosts; a Harvester VM is reachable at ${name}.${lab.domain}`);
            needImage(harvester.name, h.os);
            hosts.set(name, {
                kind: "harvester", name, os: h.os, profiles: parseProfiles(h.profiles, at), profileOrder: [], capabilities: [], providers: {}, charts: [], chartValues: {}, outputs: {}, fqdn: `${name}.${lab.domain}`,
                kubernetes: runsKubernetes(name, h.profiles),
                harvester: harvester.name, cpu: h.cpu ?? vmDefaults.cpu, memory: h.memory ?? vmDefaults.memory, disk: h.disk ?? vmDefaults.disk,
                network: checkNetwork(harvester, h.network, `${at}.network`), macAddress: h.macAddress,
            });
        }
    }

    // --- Profile rules (declared by each profile, see profiles/) -------------------------------
    for (const host of hosts.values()) {
        const network = host.kind === "harvester" ? harvesters.get(host.harvester)?.networks.find(n => n.name === host.network) : undefined;
        const caps = hostCapabilities(registry, host.profiles);
        host.capabilities = [...caps.keys()].sort();
        host.providers = Object.fromEntries([...caps].sort(([a], [b]) => a.localeCompare(b)));
        checkHostProfiles({
            registry,
            host,
            osFamily: allOs[host.os]?.family,
            networkFeatures: [...(network?.dhcp ? ["dhcp" as const] : []), ...(network?.loadBalancer ? ["loadBalancer" as const] : [])],
            profilesOf: name => hosts.get(name)?.profiles,
            error: (at, message) => diags.error(L, at, message),
            secretField: (value, at, shape) => {
                if (value === undefined) return;
                if (shape === "credentials") useCredentials(value as Credentials, L, at);
                else useSecretOrString(value as string, L, at);
            },
            secretTemplate: (template, at) => useTemplate(template, "string", L, at),
        });
    }
    if (diags.ok) {
        for (const host of hosts.values()) host.profileOrder = profileBuildOrder(registry, host.profiles);
    }

    // --- Chart profiles' values: their templates, rendered per host (§17) -------------------------
    for (const host of hosts.values()) {
        // Only from the profile that actually provides each capability (not a fallback another profile replaced).
        for (const name of Object.keys(host.profiles)) {
            for (const [cap, o] of Object.entries(registry[name]?.outputs ?? {})) if (host.providers[cap]?.includes(name)) host.outputs[cap] = o;
        }
        for (const name of Object.keys(host.profiles)) {
            const def = registry[name];
            if (!def?.charts?.length) continue;
            // Missing requirements are reported by the profile rules; its templates would only add noise.
            const caps = hostCapabilities(registry, host.profiles);
            if (activeRequirements(def, host.profiles[name]).some(c => !caps.has(c))) continue;
            // Only what the profile waits for: a template can't read a profile built after it.
            const waitFor = new Set([...(def.requires ?? []), ...(def.uses ?? []), ...(def.requiresWhen ?? []).map(r => r.capability)]);
            const ctx: TemplateContext = {
                settings: host.profiles[name],
                host: { name: host.name, fqdn: host.fqdn },
                lab: { name: lab.lab, domain: lab.domain, vars: lab.vars, tls: { acme: lab.tls.acme, privateCA: !!acme?.ca, ...(lab.tls.email ? { email: lab.tls.email } : {}) } },
                outputs: Object.fromEntries(Object.entries(host.outputs).filter(([cap]) => waitFor.has(cap))),
            };
            host.chartValues[name] = {
                entries: (def.charts ?? []).map((e, i) => {
                    const error = (field: string) => (path: string, message: string) =>
                        diags.error(def.source, docAt("Profile", name, `spec.charts[${i}].${field}${path ? `.${path}` : ""}`), `${message} (on host ${host.name})`);
                    const install = e.when === undefined ? true : renderTemplates(e.when, ctx, "", error("when"));
                    if (typeof install !== "boolean") error("when")("", `must render to true or false, not ${JSON.stringify(install)}`);
                    const version = e.version === undefined ? undefined : renderTemplates(e.version, ctx, "", error("version"));
                    return {
                        values: renderTemplates(e.values ?? {}, ctx, "", error("values")) as Record<string, unknown>,
                        lockedValues: renderTemplates(e.lockedValues ?? {}, ctx, "", error("lockedValues")) as Record<string, unknown>,
                        install: install === true,
                        ...(typeof version === "string" && version !== "" ? { version } : {}),
                        vars: Object.fromEntries(Object.entries(e.vars ?? {}).map(([k, v]) => [k, String(renderTemplates(v, ctx, "", error(`vars.${k}`)))])),
                    };
                }),
            };
        }
    }
    const describe = (capability: string) => describeCapability(registry, capability);

    // --- Secrets and configmaps (§16.6) ---------------------------------------------------------
    const objects = createObjects({
        catalog: { secrets: catalog.secrets, configmaps: catalog.configmaps },
        inputs: [{ values: personal.inputs, source: P, at: "inputs" }, { values: lab.inputs, source: L, at: "inputs" }],
        lab: { "tls.email": lab.tls.email, "tls.cloudflare": lab.tls.cloudflare, domain: lab.domain },
        diags,
        useSecret: (value, shape, source, valueAt) => shape === "credentials"
            ? useCredentials(value as Credentials, source, valueAt)
            : useSecretOrString(value as string, source, valueAt),
        describeCapability: describe,
    });
    /** Place a host's or downstream cluster's `secrets:` and `configmaps:` lists. */
    const placeAll = (target: ObjectTarget, lists: { secrets?: Placement[]; configmaps?: Placement[] }, at: string, capabilities?: { has(c: string): boolean }) => {
        for (const [kind, key] of [["Secret", "secrets"], ["ConfigMap", "configmaps"]] as const) {
            (lists[key] ?? []).forEach((p, i) => {
                const { name, namespace } = placementOf(p);
                objects.place(kind, name, { target, capabilities, namespace, required: true, source: L, at: `${at}.${key}[${i}]` });
            });
        }
    };

    // --- Fleet repos and groups (§16.3) --------------------------------------------------------
    const fleet: Record<string, ResolvedFleet> = {};
    for (const host of hosts.values()) {
        const settings = host.profiles.rancher as { plugins?: string[] | Record<string, string>; fleet?: FleetSettings } | undefined;
        if (!settings) continue;
        const at = `hosts.${host.name}.profiles.rancher`;
        if (Array.isArray(settings.plugins)) {
            const known = catalog.plugins.value.versions;
            for (const plugin of settings.plugins.filter(p => !known[p])) {
                diags.error(L, `${at}.plugins`, `no UiPlugin "${plugin}" in the catalog; known: ${Object.keys(known).sort().join(", ")}`);
            }
        }
        fleet[host.name] = resolveFleet({
            catalog: catalog.fleet,
            fleet: settings.fleet ?? {},
            host: host.name,
            capabilities: hostCapabilities(registry, host.profiles),
            at,
            labSource: L,
            objects,
            diags,
        });
    }

    // --- Downstream clusters -------------------------------------------------------------------
    const metalNodeOwner = new Map<string, string>();
    const downstream: ResolvedDownstream[] = [];
    for (const [name, d] of Object.entries(lab.downstream)) {
        const at = `downstream.${name}`;
        const rancher = hosts.get(d.rancher);
        const rancherCaps = rancher ? hostCapabilities(registry, rancher.profiles) : undefined;
        if (!rancher) diags.error(L, `${at}.rancher`, `unknown host "${d.rancher}"`);
        else if (!rancherCaps!.has("rancher")) diags.error(L, `${at}.rancher`, `host "${d.rancher}" doesn't run rancher`);
        // Machines on AWS register with Rancher over the internet.
        else if ((d.type === "ec2" || d.type === "eks") && !rancherCaps!.has("public-ingress")) {
            const what = d.type === "ec2" ? "EC2 machines reach" : "An EKS cluster's agent reaches";
            diags.error(L, `${at}.rancher`, `${what} Rancher over the internet, and the Rancher on ${d.rancher} isn't public: its host needs ${describe("public-ingress")}`);
        }

        if (d.type === "k3k") {
            const parent = lab.downstream[d.parent];
            if (!parent) diags.error(L, `${at}.parent`, `unknown downstream cluster "${d.parent}"; known: ${Object.keys(lab.downstream).filter(n => n !== name).sort().join(", ") || "none"}`);
            else if (parent.type === "k3k") diags.error(L, `${at}.parent`, `"${d.parent}" is a k3k cluster itself; a k3k cluster runs in a harvester, ec2, eks or metal cluster`);
            else if (parent.rancher !== d.rancher) diags.error(L, `${at}.parent`, `"${d.parent}" is managed by the Rancher on ${parent.rancher}, this cluster by the one on ${d.rancher}; they must be the same`);
            downstream.push({ ...d, name, namespace: d.namespace ?? `k3k-${name}` });
            continue;
        }

        if (d.type === "eks") {
            const site = awsSites.get(d.site);
            if (!site) diags.error(L, `${at}.site`, `unknown AwsSite "${d.site}"; known: ${[...awsSites.keys()].sort().join(", ") || "none (add an AwsSite document)"}`);
            else if (site.zones.length < 2) diags.error(L, `${at}.site`, `EKS needs subnets in two zones at least, and the site ${site.name} has ${site.zones.length}`);
            const groupNames = new Set<string>();
            const nodeGroups = d.nodeGroups.map((g, i) => {
                const groupAt = `${at}.nodeGroups[${i}]`;
                if (groupNames.has(g.name)) diags.error(L, `${groupAt}.name`, `node group "${g.name}" is defined twice`);
                groupNames.add(g.name);
                const min = g.min ?? g.quantity;
                const max = g.max ?? Math.max(g.quantity, min);
                if (min > g.quantity || g.quantity > max) diags.error(L, `${groupAt}.quantity`, `${g.quantity} isn't between min ${min} and max ${max}`);
                const zones = g.zones ?? site?.zones.map(z => z.letter) ?? [];
                for (const zone of zones) {
                    if (site && !site.zones.some(z => z.letter === zone)) {
                        diags.error(L, `${groupAt}.zones`, `the site ${site.name} has no subnet in zone ${zone}; its zones: ${site.zones.map(z => z.letter).join(", ")}`);
                    }
                }
                return { ...g, min, max, instanceType: g.instanceType ?? awsDefaults.instanceType, disk: g.disk ?? vmDefaults.disk, zones };
            });
            downstream.push({ ...d, name, version: d.version ?? awsDefaults.eksVersion, nodeGroups });
            continue;
        }

        // The engine owns the CNI key (use `cni`) and the Harvester cloud provider's chart values.
        if (d.machineGlobalConfig && "cni" in d.machineGlobalConfig) diags.error(L, `${at}.machineGlobalConfig.cni`, "set it with downstream cni instead");
        if (d.type === "harvester" && d.chartValues && "harvester-cloud-provider" in d.chartValues) {
            diags.error(L, `${at}.chartValues.harvester-cloud-provider`, "is set by the lab engine; it can't be overridden");
        }

        const allRoles = new Set<string>();
        if (d.type === "harvester") {
            const harvester = harvesters.get(d.harvester);
            if (!harvester) diags.error(L, `${at}.harvester`, `unknown Harvester "${d.harvester}"; known: ${[...harvesters.keys()].sort().join(", ") || "none"}`);
            const poolNames = new Set<string>();
            const pools = d.pools.map((pool, i) => {
                if (poolNames.has(pool.name)) diags.error(L, `${at}.pools[${i}].name`, `pool "${pool.name}" is defined twice`);
                poolNames.add(pool.name);
                pool.roles.forEach(r => allRoles.add(r));
                useOs(pool.os, `${at}.pools[${i}].os`);
                const sized = { ...pool, cpu: pool.cpu ?? vmDefaults.cpu, memory: pool.memory ?? vmDefaults.memory, disk: pool.disk ?? vmDefaults.disk };
                if (!harvester) return sized;
                needImage(harvester.name, pool.os);
                return { ...sized, network: checkNetwork(harvester, pool.network, `${at}.pools[${i}].network`) };
            });
            downstream.push({ ...d, name, pools });
        } else if (d.type === "ec2") {
            const site = awsSites.get(d.site);
            if (!site) diags.error(L, `${at}.site`, `unknown AwsSite "${d.site}"; known: ${[...awsSites.keys()].sort().join(", ") || "none (add an AwsSite document)"}`);
            const poolNames = new Set<string>();
            const pools = d.pools.map((pool, i) => {
                const poolAt = `${at}.pools[${i}]`;
                if (poolNames.has(pool.name)) diags.error(L, `${poolAt}.name`, `pool "${pool.name}" is defined twice`);
                poolNames.add(pool.name);
                pool.roles.forEach(r => allRoles.add(r));
                const os = useOs(pool.os, `${poolAt}.os`);
                if (os && !os.ami) diags.error(L, `${poolAt}.os`, `OS profile ${pool.os} has no AMI (ami: owner and name) to boot EC2 machines from`);
                const zone = pool.zone ?? site?.zones[0]?.letter ?? "a";
                if (site && !site.zones.some(z => z.letter === zone)) {
                    diags.error(L, `${poolAt}.zone`, `the site ${site.name} has no subnet in zone ${zone}; its zones: ${site.zones.map(z => z.letter).join(", ")}`);
                }
                return { ...pool, instanceType: pool.instanceType ?? awsDefaults.instanceType, disk: pool.disk ?? vmDefaults.disk, zone };
            });
            downstream.push({ ...d, name, pools });
        } else {
            d.nodes.forEach((node, i) => {
                node.roles.forEach(r => allRoles.add(r));
                const host = hosts.get(node.host);
                const nodeAt = `${at}.nodes[${i}].host`;
                if (!host) {
                    diags.error(L, nodeAt, `unknown host "${node.host}"`);
                    return;
                }
                const owner = metalNodeOwner.get(node.host);
                if (owner) diags.error(L, nodeAt, `host "${node.host}" is already a node of downstream cluster "${owner}"`);
                metalNodeOwner.set(node.host, name);
                const blocking = blocksMetalClusterNode(registry, host.profiles);
                if (blocking.length > 0) diags.error(L, nodeAt, `host "${node.host}" can't join a metal cluster: it runs ${blocking.join(", ")}, which can't share a host with Kubernetes`);
            });
            downstream.push({ ...d, name });
        }
        const missing = NODE_ROLES.filter(r => !allRoles.has(r));
        if (missing.length > 0) diags.error(L, at, `no node has the ${missing.join(", ")} role${missing.length > 1 ? "s" : ""}; a cluster needs at least one of each`);
    }

    // --- Charts placed on hosts (§17) ----------------------------------------------------------
    for (const host of hosts.values()) {
        const placements = lab.hosts[host.name]?.charts ?? [];
        if (placements.length === 0) continue;
        const at = `hosts.${host.name}.charts`;
        if (!host.capabilities.includes("kubernetes")) {
            diags.error(L, at, `needs ${describe("kubernetes")} on the host to install charts on`);
            continue;
        }
        placements.forEach((p, i) => {
            const c = catalog.components[p.name]?.value;
            if (!c || c.kind !== "HelmChart") {
                const charts = Object.keys(catalog.components).filter(k => catalog.components[k].value.kind === "HelmChart").sort();
                diags.error(L, `${at}[${i}].name`, `no HelmChart "${p.name}" in the catalog; known: ${charts.join(", ")}`);
                return;
            }
            if (typeof c.version !== "string") {
                diags.error(L, `${at}[${i}].name`, `HelmChart ${p.name} has a version per Harvester minor; it can only be a Harvester add-on`);
                return;
            }
            const namespace = p.namespace ?? c.namespace;
            if (!namespace) {
                diags.error(L, `${at}[${i}].namespace`, `required: HelmChart ${p.name} has no default namespace`);
                return;
            }
            walkRefs(p.values ?? {}, `${at}[${i}].values`);
            host.charts.push({ name: p.name, chart: c.chart, ...(c.repo ? { repo: c.repo } : {}), version: c.version, namespace, values: p.values ?? {} });
        });
    }

    // --- Objects placed on host and downstream clusters ----------------------------------------
    for (const host of hosts.values()) {
        const input = lab.hosts[host.name];
        if (!input?.secrets?.length && !input?.configmaps?.length) continue;
        const caps = hostCapabilities(registry, host.profiles);
        const at = `hosts.${host.name}`;
        if (!caps.has("kubernetes")) {
            diags.error(L, at, `has secrets or configmaps to create, but no ${describe("kubernetes")} to put them on`);
            continue;
        }
        placeAll({ host: host.name }, input, at, caps);
    }
    for (const d of downstream) placeAll({ downstream: d.name }, d, `downstream.${d.name}`);

    // --- Images per Harvester ------------------------------------------------------------------
    for (const [harvesterName, osNames] of imagesNeeded) {
        const harvester = harvesters.get(harvesterName)!;
        for (const osName of [...osNames].sort()) {
            const os = allOs[osName];
            if (!os) continue; // already reported
            const fromLab: ImageSource | undefined = lab.images[osName];
            const fromPersonal: ImageSource | undefined = personal.images[osName];
            const chosen = fromLab ? { src: fromLab, source: L, dir: input.labDir } : fromPersonal ? { src: fromPersonal, source: P, dir: input.personalDir } : undefined;
            if (!chosen) {
                if (os.imageUrl) {
                    harvester.images.push({ os: osName, source: { kind: "url", url: os.imageUrl } });
                } else {
                    diags.error(L, `images.${osName}`, `OS "${osName}" has no public image; add images.${osName} with a url or a local file, here or in the personal config`);
                }
                continue;
            }
            if ("url" in chosen.src) {
                harvester.images.push({ os: osName, source: { kind: "url", url: chosen.src.url } });
            } else {
                const file = expand(chosen.src.file, chosen.dir);
                if (!input.fs.exists(file)) diags.error(chosen.source, `images.${osName}.file`, `file not found: ${file}`);
                harvester.images.push({ os: osName, source: { kind: "file", path: file } });
            }
        }
    }

    // --- Top level: vars, TLS, SSH, unused harvesters --------------------------------------------
    // A secret in vars ("{{ secrets.token }}") is fetched like any other: a template that reads it gets the value.
    const walkVars = (value: unknown, at: string): void => {
        if (typeof value === "string") { if (usesSecrets(value)) useTemplate(value, "string", L, at); }
        else if (Array.isArray(value)) value.forEach((v, i) => walkVars(v, `${at}[${i}]`));
        else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walkVars(v, `${at}.${k}`);
    };
    walkVars(lab.vars, "vars");

    const anyHosts = hosts.size > 0;
    if (anyHosts && lab.tls.acme !== "none") {
        if (!lab.tls.email) diags.error(L, "tls.email", `required for ACME (tls.acme: ${lab.tls.acme})`);
        if (!lab.tls.cloudflare) diags.error(L, "tls.cloudflare", `required for ACME DNS-01, e.g. "{{ secrets.cloudflare.token }}"`);
    }
    useSecretOrString(lab.tls.cloudflare, L, "tls.cloudflare");
    // cert-manager issues the lab's certificates from its ACME server: without one it has nothing to do.
    if (lab.tls.acme === "none") {
        for (const host of hosts.values()) {
            if ("cert-manager" in host.profiles) diags.error(L, `hosts.${host.name}.profiles.cert-manager`, "issues certificates from the lab's ACME server; set tls.acme (and tls.email, tls.cloudflare), not none");
        }
    }

    let ssh: ResolvedLab["ssh"];
    if (lab.ssh) {
        useSecretOrString(lab.ssh.privateKey, L, "ssh.privateKey");
        let publicKey = typeof lab.ssh.publicKey === "string" ? lab.ssh.publicKey : "";
        if (typeof lab.ssh.publicKey !== "string") {
            const file = expand(lab.ssh.publicKey.file, input.labDir);
            if (input.fs.exists(file)) publicKey = input.fs.read(file).trim();
            else diags.error(L, "ssh.publicKey.file", `file not found: ${file}`);
        }
        ssh = { user: lab.ssh.user ?? catalog.defaults.value.ssh.user, publicKey, privateKey: lab.ssh.privateKey };
    } else if (anyHosts) {
        diags.error(L, "ssh", "required when the lab has hosts (user, publicKey, privateKey)");
    }

    const usedSites = new Set(downstream.flatMap(d => d.type === "ec2" || d.type === "eks" ? [d.site] : []));
    for (const name of awsSites.keys()) {
        if (!usedSites.has(name)) diags.warning(L, `awsSites.${name}`, "no downstream cluster uses it; the lab still creates its VPC there");
    }

    const usedHarvesters = new Set([
        ...[...hosts.values()].flatMap(h => h.kind === "harvester" ? [h.harvester] : []),
        ...downstream.flatMap(d => d.type === "harvester" ? [d.harvester] : []),
    ]);
    for (const name of harvesters.keys()) {
        if (!usedHarvesters.has(name)) {
            diags.warning(L, `harvesters.${name}`, "no host or downstream cluster uses it; it is still claimed and gets the lab's base resources");
        }
    }

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
            profileCharts: Object.fromEntries(Object.values(catalog.profiles).filter(p => p.charts?.length).map(p => [p.name, {
                entries: p.charts!.map((e, i) => e.chart !== undefined
                    ? { kind: "chart" as const, chart: e.chart, namespace: e.namespace!, main: i === p.charts!.findIndex(x => x.chart !== undefined) }
                    : { kind: "manifest" as const, manifest: e.manifest! }),
                provides: [p.name, ...(p.provides ?? [])],
                waitFor: [...(p.requires ?? []), ...(p.uses ?? []), ...(p.requiresWhen ?? []).map(r => r.capability)],
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
        },
    };
}

// --- IPv4 helpers -----------------------------------------------------------------------------

export const toInt = (ip: string) => ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
const toIp = (n: number) => [24, 16, 8, 0].map(shift => Math.floor(n / 2 ** shift) % 256).join(".");

/** The n-th address of a CIDR, e.g. nthAddress("10.29.20.0/24", 2) = "10.29.20.2". */
export function nthAddress(cidr: string, n: number): string {
    const [base, bits] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    return toIp(toInt(base) - (toInt(base) % size) + n);
}

export function inCidr(ip: string, cidr: string): boolean {
    const [base, bits] = cidr.split("/");
    const size = 2 ** (32 - Number(bits));
    const start = toInt(base) - (toInt(base) % size);
    return toInt(ip) >= start && toInt(ip) < start + size;
}
