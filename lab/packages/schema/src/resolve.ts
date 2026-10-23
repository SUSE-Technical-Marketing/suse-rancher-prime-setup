import * as path from "node:path";
import { Diagnostics } from "./diagnostics";
import { CatalogLayer, catalogValues, ResolvedAcmeServer, ResolvedComponent, ResolvedPlugins, resolveCatalog } from "./catalog";
import { FleetSettings, ResolvedFleet, resolveFleet } from "./fleet";
import { createObjects, ObjectTarget, Placement, placementOf, ResolvedObject } from "./objects";
import { docAt } from "./documents";
import { renderTemplates, TemplateContext } from "./templates";
import { ResolvedOs } from "./os";
import { Profiles } from "./profiles";
import { activeRequirements, blocksCustomClusterNode, checkHostProfiles, describeCapability, hostCapabilities, profileBuildOrder } from "./profiles/rules";
import {
    Credentials, DownstreamInput, HarvesterInput, ImageSource, LabFile, NODE_ROLES,
    PersonalConfig, SecretRef, VersionValue,
} from "./schema";

// ---------------------------------------------------------------------------------------------
// Resolved model: plain JSON, handed to the Pulumi program as stack config. Secret references
// stay as `{ $secret }`; the program swaps in the values it receives separately.

export type SecretShape = "string" | "credentials";

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
    storageClass: { name: string; replicas: number };
    dns?: HarvesterInput["dns"];
    networks: ResolvedNetwork[];
    defaultNetwork: string;
    /** One image per OS used by hosts or downstream pools on this Harvester. */
    images: { os: string; source: ResolvedImageSource }[];
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

export type ResolvedDownstream = DownstreamInput & { name: string };

export interface ResolvedLab {
    name: string;
    domain: string;
    tls: LabFile["tls"];
    /** The AcmeServer `tls.acme` names; none for `tls.acme: none`. */
    acme?: ResolvedAcmeServer;
    ssh?: { user: string; publicKey: string; privateKey: SecretRef };
    /** Everything the lab can install and its version, from the catalog (§16). */
    components: Record<string, ResolvedComponent>;
    /** For each profile with a chart: which chart, its namespace, default and locked values (§17). */
    profileCharts: Record<string, ProfileChart>;
    /** The UI plugin repository and default plugin set, from the catalog. */
    plugins: ResolvedPlugins;
    harvesters: ResolvedHarvester[];
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

    const needSecret = (ref: SecretRef, shape: SecretShape, source: string, at: string) => {
        const existing = secrets[ref.$secret];
        if (existing && existing !== shape) {
            diags.error(source, at, `secret "${ref.$secret}" is used both as ${existing} and as ${shape}`);
        }
        secrets[ref.$secret] = shape;
    };

    const isSecret = (v: unknown): v is SecretRef => typeof v === "object" && v !== null && "$secret" in v;

    /** Register every `{ $secret }` in a free-form value (chart values) as a string secret. */
    const walkRefs = (value: unknown, at: string): void => {
        if (isSecret(value)) needSecret(value, "string", L, at);
        else if (Array.isArray(value)) value.forEach((v, i) => walkRefs(v, `${at}[${i}]`));
        else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walkRefs(v, `${at}.${k}`);
    };

    /** Register the secrets in a credentials value; warn about passwords written into the lab file. */
    const useCredentials = (creds: Credentials, source: string, at: string) => {
        if (isSecret(creds)) {
            needSecret(creds, "credentials", source, at);
        } else if (isSecret(creds.password)) {
            needSecret(creds.password, "string", source, `${at}.password`);
        } else if (source === L) {
            diags.warning(source, `${at}.password`, "password is written in the lab file; use { $secret: ... } before sharing it");
        }
    };

    const useSecretOrString = (v: SecretRef | string | undefined, source: string, at: string) => {
        if (v === undefined) return;
        if (isSecret(v)) needSecret(v, "string", source, at);
        else if (source === L) diags.warning(source, at, "secret value is written in the lab file; use { $secret: ... } before sharing it");
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
            useSecretOrString(os.registration?.suseconnect?.regcode, `OS profile ${name}`, "registration.suseconnect.regcode");
        }
        return os;
    };

    // --- Harvesters --------------------------------------------------------------------------
    const harvesters = new Map<string, ResolvedHarvester>();
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
            if (!inCidr(server, dhcp.cidr)) diags.error(L, `${at}.server`, `${server} is outside ${dhcp.cidr}`);
            for (const [i, ip] of [dhcp.gateway, ...dhcp.range].entries()) {
                if (!inCidr(ip, dhcp.cidr)) diags.error(L, `${at}.${i === 0 ? "gateway" : `range[${i - 1}]`}`, `${ip} is outside ${dhcp.cidr}`);
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
            clusterNetwork: h.clusterNetwork,
            storageClass: h.storageClass,
            dns: h.dns,
            networks,
            defaultNetwork,
            images: [],
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
        set.add(os);
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
    for (const [name, h] of Object.entries(lab.hosts)) {
        const at = `hosts.${name}`;
        useOs(h.os, `${at}.os`);

        if (h.on === "ssh") {
            for (const field of ["cpu", "memory", "disk", "network", "macAddress"] as const) {
                if (h[field] !== undefined) diags.error(L, `${at}.${field}`, `doesn't apply to an ssh host`);
            }
            if (!h.address) diags.error(L, `${at}.address`, "required for an ssh host (its DNS name or IP)");
            hosts.set(name, {
                kind: "ssh", name, os: h.os, profiles: parseProfiles(h.profiles, at), profileOrder: [], capabilities: [], providers: {}, charts: [], chartValues: {}, outputs: {},
                address: h.address ?? "", fqdn: h.address ?? "", user: h.user ?? lab.ssh?.user ?? "root",
            });
        } else {
            const harvester = harvesters.get(h.on);
            if (!harvester) {
                diags.error(L, `${at}.on`, `unknown Harvester "${h.on}"; known: ${[...harvesters.keys()].sort().join(", ") || "none (add a Harvester document)"}`);
                continue;
            }
            if (h.address !== undefined) diags.error(L, `${at}.address`, `only applies to ssh hosts; a Harvester VM is reachable at ${name}.${lab.domain}`);
            for (const field of ["cpu", "memory", "disk"] as const) {
                if (h[field] === undefined) diags.error(L, `${at}.${field}`, "required for a Harvester VM");
            }
            needImage(harvester.name, h.os);
            hosts.set(name, {
                kind: "harvester", name, os: h.os, profiles: parseProfiles(h.profiles, at), profileOrder: [], capabilities: [], providers: {}, charts: [], chartValues: {}, outputs: {}, fqdn: `${name}.${lab.domain}`,
                harvester: harvester.name, cpu: h.cpu ?? 0, memory: h.memory ?? "", disk: h.disk ?? "",
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
                else useSecretOrString(value as SecretRef | string, L, at);
            },
            secretRef: (ref, at) => needSecret(ref, "string", L, at),
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
                lab: { name: lab.lab, domain: lab.domain, tls: { acme: lab.tls.acme, privateCA: !!acme?.ca, ...(lab.tls.email ? { email: lab.tls.email } : {}) } },
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
            : useSecretOrString(value as SecretRef | string, source, valueAt),
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
    const customNodeOwner = new Map<string, string>();
    const downstream: ResolvedDownstream[] = [];
    for (const [name, d] of Object.entries(lab.downstream)) {
        const at = `downstream.${name}`;
        const rancher = hosts.get(d.rancher);
        if (!rancher) diags.error(L, `${at}.rancher`, `unknown host "${d.rancher}"`);
        else if (!hostCapabilities(registry, rancher.profiles).has("rancher")) diags.error(L, `${at}.rancher`, `host "${d.rancher}" doesn't run rancher`);

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
                if (!harvester) return pool;
                needImage(harvester.name, pool.os);
                return { ...pool, network: checkNetwork(harvester, pool.network, `${at}.pools[${i}].network`) };
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
                const owner = customNodeOwner.get(node.host);
                if (owner) diags.error(L, nodeAt, `host "${node.host}" is already a node of downstream cluster "${owner}"`);
                customNodeOwner.set(node.host, name);
                const blocking = blocksCustomClusterNode(registry, host.profiles);
                if (blocking.length > 0) diags.error(L, nodeAt, `host "${node.host}" can't join a custom cluster: it runs ${blocking.join(", ")}, which can't share a host with Kubernetes`);
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

    // --- Top level: TLS, SSH, unused harvesters --------------------------------------------------
    const anyHosts = hosts.size > 0;
    if (anyHosts && lab.tls.acme !== "none") {
        if (!lab.tls.email) diags.error(L, "tls.email", `required for ACME (tls.acme: ${lab.tls.acme})`);
        if (!lab.tls.cloudflare) diags.error(L, "tls.cloudflare", `required for ACME DNS-01, e.g. { $secret: cloudflare-token }`);
    }
    if (lab.tls.cloudflare) needSecret(lab.tls.cloudflare, "string", L, "tls.cloudflare");

    let ssh: ResolvedLab["ssh"];
    if (lab.ssh) {
        needSecret(lab.ssh.privateKey, "string", L, "ssh.privateKey");
        let publicKey = typeof lab.ssh.publicKey === "string" ? lab.ssh.publicKey : "";
        if (typeof lab.ssh.publicKey !== "string") {
            const file = expand(lab.ssh.publicKey.file, input.labDir);
            if (input.fs.exists(file)) publicKey = input.fs.read(file).trim();
            else diags.error(L, "ssh.publicKey.file", `file not found: ${file}`);
        }
        ssh = { user: lab.ssh.user, publicKey, privateKey: lab.ssh.privateKey };
    } else if (anyHosts) {
        diags.error(L, "ssh", "required when the lab has hosts (user, publicKey, privateKey)");
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
            hosts: [...hosts.values()],
            downstream,
            os: usedOs,
            fleet,
            objects: objects.objects,
            skippedObjects: objects.skipped,
            secrets,
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
