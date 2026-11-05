// Harvesters: their login, networks (DHCP, subnets, load-balancer pools) and storage class.

import type { ResolvedNetwork } from "../resolve";
import { inCidr, nthAddress, toInt } from "../net";
import type { Resolution } from "./context";

/** The lab's Harvesters, with the personal config's address and login. */
export function resolveHarvesters(r: Resolution): void {
    const { lab, L, P, personal, diags, useCredentials, harvesters, hvDefaults } = r;
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
        /** A network's load-balancer pool: its cidr and gateway default to the network's subnet (its DHCP's, or its own). */
        const withPool = (pool: PoolInput | undefined, dhcp: ResolvedNetwork["dhcp"], subnet: ResolvedNetwork["subnet"], poolAt: string): ResolvedNetwork["loadBalancer"] => {
            if (!pool) return undefined;
            const cidr = pool.cidr ?? subnet?.cidr;
            const gateway = pool.gateway ?? subnet?.gateway;
            if (!cidr || !gateway) {
                diags.error(L, poolAt, "needs cidr and gateway: the network has neither lab DHCP nor a cidr and gateway of its own");
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
        /** A network's subnet for fixed addresses: its DHCP's, or its own (a network without lab DHCP). */
        const subnetOf = (net: { dhcp?: unknown; cidr?: string; gateway?: string; dns?: string[] }, dhcp: ResolvedNetwork["dhcp"], netAt: string): ResolvedNetwork["subnet"] => {
            const own = net.cidr !== undefined || net.gateway !== undefined || net.dns !== undefined;
            if (dhcp) {
                if (own) diags.error(L, netAt, "has lab DHCP: its cidr, gateway and dns are under dhcp");
                return { cidr: dhcp.cidr, gateway: dhcp.gateway, dns: dhcp.dns ?? [dhcp.gateway] };
            }
            if (!own) return undefined;
            if (!net.cidr || !net.gateway) {
                diags.error(L, netAt, "needs both cidr and gateway, for its VMs' fixed addresses");
                return undefined;
            }
            const [base, bits] = net.cidr.split("/");
            if (nthAddress(net.cidr, 0) !== base) diags.error(L, `${netAt}.cidr`, `${net.cidr} isn't the start of its range; use ${nthAddress(net.cidr, 0)}/${bits}`);
            if (!inCidr(net.gateway, net.cidr)) diags.error(L, `${netAt}.gateway`, `${net.gateway} is outside ${net.cidr}`);
            return { cidr: net.cidr, gateway: net.gateway, dns: net.dns ?? [net.gateway] };
        };
        const untaggedDhcp = withServer(h.networks.untagged.dhcp, `${at}.networks.untagged.dhcp`);
        const untaggedSubnet = subnetOf(h.networks.untagged, untaggedDhcp, `${at}.networks.untagged`);
        const networks: ResolvedNetwork[] = [{
            name: "untagged",
            dhcp: untaggedDhcp,
            subnet: untaggedSubnet,
            loadBalancer: withPool(h.networks.untagged.loadBalancer, untaggedDhcp, untaggedSubnet, `${at}.networks.untagged.loadBalancer`),
        }];
        const seenVlans = new Set<number>();
        h.networks.vlans.forEach((vlan, i) => {
            if (seenVlans.has(vlan.id)) diags.error(L, `${at}.networks.vlans[${i}].id`, `VLAN ${vlan.id} is defined twice`);
            seenVlans.add(vlan.id);
            const dhcp = withServer(vlan.dhcp, `${at}.networks.vlans[${i}].dhcp`);
            const subnet = subnetOf(vlan, dhcp, `${at}.networks.vlans[${i}]`);
            networks.push({
                name: `vlan${vlan.id}`, vlanId: vlan.id, dhcp, subnet,
                loadBalancer: withPool(vlan.loadBalancer, dhcp, subnet, `${at}.networks.vlans[${i}].loadBalancer`),
            });
        });
        const defaultNetwork = h.networks.default ?? "untagged";
        if (!networks.some(n => n.name === defaultNetwork)) {
            diags.error(L, `${at}.networks.default`, `unknown network "${defaultNetwork}"; known: ${networks.map(n => n.name).join(", ")}`);
        }

        const scName = h.storageClass?.name ?? hvDefaults.storageClass.name;
        harvesters.set(name, {
            name,
            url: url ?? "",
            credentials: credentials ?? { username: "", password: "" },
            insecure: h.insecure ?? mine.insecure ?? true,
            clusterNetwork: h.clusterNetwork ?? hvDefaults.clusterNetwork,
            storageClass: {
                name: scName,
                replicas: h.storageClass?.replicas ?? hvDefaults.storageClass.replicas,
                parameters: { ...hvDefaults.storageClass.parameters, ...h.storageClass?.parameters },
                imageClass: h.storageClass?.imageClass ?? scName,
            },
            profiles: {}, // checked with the other profiles, below
            chartValues: {},
            networks,
            defaultNetwork,
            images: [],
        });
    }
}
