// Lab hosts: VMs on a Harvester and existing machines, their fixed addresses, their profiles' rules
// and build order, and their profiles' chart values rendered.

import type { ResolvedHarvester, ResolvedHarvesterHost } from "../resolve";
import { checkHostProfiles, hostCapabilities, profileBuildOrder } from "../profiles/rules";
import type { Credentials } from "../schema";
import { inCidr, nthAddress, toInt } from "../net";
import type { Resolution } from "./context";

/** cloud-config keys an existing machine (no user data) gets, over SSH instead (packages are always refreshed first). */
export const MACHINE_CLOUD_INIT_KEYS = ["packages", "runcmd", "package_update"];

/** The lab's hosts, their profiles checked and ordered, and their charts' values. */
export function resolveHosts(r: Resolution): void {
    const { lab, L, diags, useOs, allOs, catalog, registry, harvesters, hosts, vmDefaults, needImage, checkNetwork, parseProfiles, useCredentials, useSecretOrString, useTemplate, renderProfile } = r;
    /**
     * A VM's fixed address (`ip`), set in the VM itself, on a lab network (its subnet from the network)
     * or one already on the Harvester (with its prefix and gateway): inside the subnet, outside its
     * DHCP range and load-balancer pool, not one of its own addresses, and unique in the lab. A VM
     * without one gets its address from DHCP: the lab's, or one already on the network (the LAN's).
     */
    const fixedTaken = new Map<string, string>();
    const fixedAddress = (harvester: ResolvedHarvester, network: string, h: { ip?: string; gateway?: string; dns?: string[] }, at: string): { ip?: ResolvedHarvesterHost["ip"] } => {
        const net = harvester.networks.find(n => n.name === network);
        const existing = network.includes("/");
        if (!h.ip) {
            for (const f of ["gateway", "dns"] as const) if (h[f] !== undefined) diags.error(L, `${at}.${f}`, "only goes with ip");
            return {};
        }
        const [address, prefixText] = h.ip.split("/");
        if (address.split(".").some(o => Number(o) > 255)) {
            diags.error(L, `${at}.ip`, `${address} isn't an IPv4 address`);
            return {};
        }
        let subnet: { cidr: string; gateway: string; dns: string[] };
        if (existing) {
            // The lab doesn't know this network: the VM says what it looks like.
            if (!prefixText) diags.error(L, `${at}.ip`, `needs its prefix (${address}/24) on ${network}, a network the lab doesn't declare`);
            if (!h.gateway) diags.error(L, `${at}.gateway`, `required with ip on ${network}, a network the lab doesn't declare`);
            if (!prefixText || !h.gateway) return {};
            subnet = { cidr: `${nthAddress(`${address}/${prefixText}`, 0)}/${prefixText}`, gateway: h.gateway, dns: h.dns ?? [h.gateway] };
        } else {
            for (const f of ["gateway", "dns"] as const) if (h[f] !== undefined) diags.error(L, `${at}.${f}`, `comes from the network ${network}; set it there`);
            if (!net) return {}; // reported by checkNetwork
            if (!net.subnet) {
                diags.error(L, `${at}.ip`, `${network} has neither lab DHCP nor a cidr: give the network cidr and gateway`);
                return {};
            }
            subnet = net.subnet;
            const bits = subnet.cidr.split("/")[1];
            if (prefixText !== undefined && prefixText !== bits) diags.error(L, `${at}.ip`, `/${prefixText} doesn't match ${network}'s ${subnet.cidr}; leave the prefix out`);
        }
        const prefix = Number(subnet.cidr.split("/")[1]);
        const problem = !inCidr(address, subnet.cidr) ? `${address} is outside ${network}'s ${subnet.cidr}`
            : address === nthAddress(subnet.cidr, 0) ? `${address} is the network's own address`
            : address === nthAddress(subnet.cidr, 2 ** (32 - prefix) - 1) ? `${address} is the network's broadcast address`
            : address === subnet.gateway ? `${address} is the gateway`
            : address === net?.dhcp?.server ? `${address} is the DHCP server`
            : net?.dhcp && toInt(address) >= toInt(net.dhcp.range[0]) && toInt(address) <= toInt(net.dhcp.range[1]) ? `${address} is in the DHCP range ${net.dhcp.range[0]}-${net.dhcp.range[1]}; a fixed address goes outside it`
            : net?.loadBalancer && toInt(address) >= toInt(net.loadBalancer.range[0]) && toInt(address) <= toInt(net.loadBalancer.range[1]) ? `${address} is in the load-balancer pool ${net.loadBalancer.range[0]}-${net.loadBalancer.range[1]}`
            : undefined;
        if (problem) {
            diags.error(L, `${at}.ip`, problem);
            return {};
        }
        const key = `${harvester.name}/${network}/${address}`;
        const other = fixedTaken.get(key);
        if (other) diags.error(L, `${at}.ip`, `${address} is ${other}'s fixed address too`);
        fixedTaken.set(key, at.replace(/^hosts\./, ""));
        return { ip: { address, prefix, gateway: subnet.gateway, dns: subnet.dns } };
    };

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
            if (h.address !== undefined) diags.error(L, `${at}.address`, `only applies to ssh hosts; a Harvester VM is reachable at ${name}.${lab.domain}, or its ip`);
            needImage(harvester.name, h.os);
            const network = checkNetwork(harvester, h.network, `${at}.network`);
            hosts.set(name, {
                kind: "harvester", name, os: h.os, profiles: parseProfiles(h.profiles, at), profileOrder: [], capabilities: [], providers: {}, charts: [], chartValues: {},
                outputs: {}, fqdn: h.fqdn ?? `${name}.${lab.domain}`,
                kubernetes: runsKubernetes(name, h.profiles),
                harvester: harvester.name, cpu: h.cpu ?? vmDefaults.cpu, memory: h.memory ?? vmDefaults.memory, disk: h.disk ?? vmDefaults.disk,
                network, macAddress: h.macAddress,
                ...fixedAddress(harvester, network, h, at),
            });
        }
    }

    // --- Profile rules (declared by each profile, see profiles/) -------------------------------
    for (const host of hosts.values()) {
        const network = host.kind === "harvester" ? harvesters.get(host.harvester)?.networks.find(n => n.name === host.network) : undefined;
        // Where the lab declares that network: its Harvester's untagged network or one of its VLANs.
        const vlanIndex = host.kind === "harvester" && network?.vlanId !== undefined
            ? (lab.harvesters[host.harvester]?.networks.vlans ?? []).findIndex(v => v.id === network.vlanId) : -1;
        const networkAt = host.kind !== "harvester" || !network ? undefined
            : network.name === "untagged" ? `harvesters.${host.harvester}.networks.untagged`
            : vlanIndex >= 0 ? `harvesters.${host.harvester}.networks.vlans[${vlanIndex}]` : undefined;
        const caps = hostCapabilities(registry, host.profiles);
        host.capabilities = [...caps.keys()].sort();
        host.providers = Object.fromEntries([...caps].sort(([a], [b]) => a.localeCompare(b)));
        checkHostProfiles({
            registry,
            host,
            osFamily: allOs[host.os]?.family,
            networkFeatures: [...(network?.dhcp ? ["dhcp" as const] : []), ...(network?.loadBalancer ? ["loadBalancer" as const] : [])],
            networkAt,
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
            const rendered = renderProfile(name, host.profiles, host.outputs, { host: { name: host.name, fqdn: host.fqdn }, target: { kind: "host", name: host.name, fqdn: host.fqdn } }, `host ${host.name}`);
            if (rendered) host.chartValues[name] = rendered;
        }
    }
}
