// Lab hosts: VMs on a Harvester and existing machines, their fixed addresses, their profiles' rules
// and build order, and their profiles' chart values rendered.

import { checkHostProfiles, hostCapabilities, profileBuildOrder } from "../profiles/rules";
import type { Credentials } from "../schema";
import type { Resolution } from "./context";

/** cloud-config keys an existing machine (no user data) gets, over SSH instead (packages are always refreshed first). */
export const MACHINE_CLOUD_INIT_KEYS = ["packages", "runcmd", "package_update"];

/** The lab's hosts, their profiles checked and ordered, and their charts' values. */
export function resolveHosts(r: Resolution): void {
    const { lab, L, diags, useOs, allOs, catalog, registry, harvesters, hosts, vmDefaults, needImage, checkNetwork, fixedAddress, parseProfiles, useCredentials, useSecretOrString, useTemplate, renderProfile } = r;

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
