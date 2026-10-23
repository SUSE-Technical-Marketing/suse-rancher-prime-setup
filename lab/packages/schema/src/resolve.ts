import * as path from "node:path";
import { Diagnostics } from "./diagnostics";
import { OsLayerEntry, ResolvedOs, resolveOsProfiles } from "./os";
import { ProfileName, Profiles } from "./profiles";
import { blocksCustomClusterNode, checkHostProfiles, hostCapabilities, profileBuildOrder } from "./profiles/rules";
import {
    Credentials, DownstreamInput, HarvesterInput, ImageSource, LabFile, NODE_ROLES,
    OsProfileInput, PersonalConfig, SecretRef,
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

interface ResolvedHostBase {
    name: string;
    os: string;
    profiles: Profiles;
    /** The host's profiles in build order: each after the profiles it requires. */
    profileOrder: ProfileName[];
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
    ssh?: { user: string; publicKey: string; privateKey: SecretRef };
    versions: Record<string, string>;
    harvesters: ResolvedHarvester[];
    hosts: ResolvedHost[];
    downstream: ResolvedDownstream[];
    /** Only the OS profiles the lab actually uses. */
    os: Record<string, ResolvedOs>;
    /** Every secret the lab needs, with the shape its value must have. */
    secrets: Record<string, SecretShape>;
}

// ---------------------------------------------------------------------------------------------

export interface ResolveInput {
    lab: LabFile;
    labSource: string;
    personal: PersonalConfig;
    personalSource: string;
    /** Built-in OS profiles, keyed by name, with the file each came from. */
    builtinOs: Record<string, OsLayerEntry>;
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

    // --- OS profiles -------------------------------------------------------------------------
    const layer = (profiles: Record<string, OsProfileInput>, source: string) =>
        Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { profile, source: `${source} (os.${name})` }]));
    const allOs = resolveOsProfiles([input.builtinOs, layer(personal.os, P), layer(lab.os, L)], diags);
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
                kind: "ssh", name, os: h.os, profiles: h.profiles, profileOrder: [],
                address: h.address ?? "", fqdn: h.address ?? "", user: h.user ?? lab.ssh?.user ?? "root",
            });
        } else {
            const harvester = harvesters.get(h.on);
            if (!harvester) {
                diags.error(L, `${at}.on`, `unknown harvester "${h.on}"; use a name from harvesters: or "ssh"`);
                continue;
            }
            if (h.address !== undefined) diags.error(L, `${at}.address`, `only applies to ssh hosts; a Harvester VM is reachable at ${name}.${lab.domain}`);
            for (const field of ["cpu", "memory", "disk"] as const) {
                if (h[field] === undefined) diags.error(L, `${at}.${field}`, "required for a Harvester VM");
            }
            needImage(harvester.name, h.os);
            hosts.set(name, {
                kind: "harvester", name, os: h.os, profiles: h.profiles, profileOrder: [], fqdn: `${name}.${lab.domain}`,
                harvester: harvester.name, cpu: h.cpu ?? 0, memory: h.memory ?? "", disk: h.disk ?? "",
                network: checkNetwork(harvester, h.network, `${at}.network`), macAddress: h.macAddress,
            });
        }
    }

    // --- Profile rules (declared by each profile, see profiles/) -------------------------------
    for (const host of hosts.values()) {
        const network = host.kind === "harvester" ? harvesters.get(host.harvester)?.networks.find(n => n.name === host.network) : undefined;
        checkHostProfiles({
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
        for (const host of hosts.values()) host.profileOrder = profileBuildOrder(host.profiles);
    }

    // --- Downstream clusters -------------------------------------------------------------------
    const customNodeOwner = new Map<string, string>();
    const downstream: ResolvedDownstream[] = [];
    for (const [name, d] of Object.entries(lab.downstream)) {
        const at = `downstream.${name}`;
        const rancher = hosts.get(d.rancher);
        if (!rancher) diags.error(L, `${at}.rancher`, `unknown host "${d.rancher}"`);
        else if (!hostCapabilities(rancher.profiles).has("rancher")) diags.error(L, `${at}.rancher`, `host "${d.rancher}" doesn't run rancher`);

        const allRoles = new Set<string>();
        if (d.type === "harvester") {
            const harvester = harvesters.get(d.harvester);
            if (!harvester) diags.error(L, `${at}.harvester`, `unknown harvester "${d.harvester}"`);
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
                const blocking = blocksCustomClusterNode(host.profiles);
                if (blocking.length > 0) diags.error(L, nodeAt, `host "${node.host}" can't join a custom cluster: it runs ${blocking.join(", ")}, which can't share a host with Kubernetes`);
            });
            downstream.push({ ...d, name });
        }
        const missing = NODE_ROLES.filter(r => !allRoles.has(r));
        if (missing.length > 0) diags.error(L, at, `no node has the ${missing.join(", ")} role${missing.length > 1 ? "s" : ""}; a cluster needs at least one of each`);
    }

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
            ssh,
            versions: lab.versions,
            harvesters: [...harvesters.values()],
            hosts: [...hosts.values()],
            downstream,
            os: usedOs,
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
