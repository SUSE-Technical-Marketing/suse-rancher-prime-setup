import { z } from "zod";
import { addressFields } from "../addressing";
import { form } from "../form";
import { dnsLabel, quantity } from "../primitives";
import { annotations, checkDistro, checkPassthrough, checkRoles, ClusterPassthrough, distro, fleetProfiles, kubernetesVersion, labels, profiles, rancher, roles } from "./common";
import type { FixedAddress } from "../resolve";
import type { ClusterType } from "./types";

// A cluster Rancher creates from VMs on one of the lab's Harvesters, with its Harvester node driver.

const HarvesterPool = z.strictObject({
    name: dnsLabel,
    quantity: z.int().min(1),
    roles,
    os: z.string().min(1).meta(form({ label: "OS", options: "osProfiles" })),
    /** Default: the catalog's Defaults (`vm`). */
    cpu: z.int().min(1).optional().meta(form({ label: "CPUs", placeholder: "default {defaults.vm.cpu}" })),
    memory: quantity.optional().meta(form({ placeholder: "default {defaults.vm.memory}" })),
    disk: quantity.optional().meta(form({ placeholder: "default {defaults.vm.disk}" })),
    network: z.string().optional().meta(form({ options: "networks", placeholder: "the Harvester's default" })),
    /** Its one machine's own network settings, for a network without DHCP: `quantity` 1 (see below). */
    ...addressFields,
}).superRefine((pool, ctx) => {
    // Rancher gives every machine in a pool the same machine config: one address, one MAC.
    if ((pool.ip !== undefined || pool.macAddress !== undefined) && pool.quantity !== 1) {
        ctx.addIssue({ code: "custom", path: ["quantity"], message: "must be 1 with a fixed ip or macAddress: every machine in a pool gets the same network settings" });
    }
});

export const HarvesterClusterInput = z.strictObject({
    type: z.literal("harvester").meta(form({ section: "hidden" })),
    rancher,
    harvester: z.string().meta(form({ label: "Harvester", options: "harvesters" })),
    distro,
    version: kubernetesVersion,
    labels,
    annotations,
    fleetProfiles,
    profiles,
    ...ClusterPassthrough,
    pools: z.array(HarvesterPool).min(1).meta(form({ label: "Machine pools", cards: { add: "a pool", title: "name" } })),
});
type Input = z.infer<typeof HarvesterClusterInput>;

/** Its pools with their machine size filled in, their networks checked, and a one-machine pool's fixed address resolved. */
export type ResolvedHarvesterPool = Omit<Input["pools"][number], "ip"> & { cpu: number; memory: string; disk: string; ip?: FixedAddress };
export type ResolvedHarvesterCluster = Omit<Input, "pools"> & { name: string; pools: ResolvedHarvesterPool[] };

export const harvesterCluster: ClusterType<Input, ResolvedHarvesterCluster> = {
    resolve(ctx, name, d, at) {
        checkPassthrough(ctx, d, at);
        checkDistro(ctx, d.distro, at);
        // The engine sets the Harvester cloud provider's chart values.
        if (d.chartValues && "harvester-cloud-provider" in d.chartValues) {
            ctx.error(`${at}.chartValues.harvester-cloud-provider`, "is set by the lab engine; it can't be overridden");
        }
        const harvester = ctx.harvesters.get(d.harvester);
        if (!harvester) ctx.error(`${at}.harvester`, `unknown Harvester "${d.harvester}"; known: ${[...ctx.harvesters.keys()].sort().join(", ") || "none"}`);
        const poolNames = new Set<string>();
        const pools = d.pools.map((pool, i) => {
            if (poolNames.has(pool.name)) ctx.error(`${at}.pools[${i}].name`, `pool "${pool.name}" is defined twice`);
            poolNames.add(pool.name);
            ctx.useOs(pool.os, `${at}.pools[${i}].os`);
            const vm = ctx.defaults.vm;
            const { ip, ...rest } = pool;
            const sized = { ...rest, cpu: pool.cpu ?? vm.cpu, memory: pool.memory ?? vm.memory, disk: pool.disk ?? vm.disk };
            if (!harvester) return sized;
            ctx.needImage(harvester.name, pool.os);
            const network = ctx.checkNetwork(harvester, pool.network, `${at}.pools[${i}].network`);
            return { ...sized, network, ...ctx.fixedAddress(harvester, network, { ip, gateway: pool.gateway, dns: pool.dns }, `${at}.pools[${i}]`) };
        });
        checkRoles(ctx, d.pools, at);
        return { ...d, name, pools };
    },
    nodeOs: d => d.pools.map((p, i) => ({ os: p.os, at: `downstream.${d.name}.pools[${i}].os` })),
    plan: (d, meta) => [
        `  ${d.name}  ${d.distro} on ${d.harvester}, managed by Rancher on ${d.rancher}${meta}`,
        ...d.pools.map(p => `    pool ${p.name}: ${p.quantity} × ${p.cpu} CPU / ${p.memory} / ${p.disk}, ${p.os}, network ${p.network}${p.ip ? ` at ${p.ip.address}/${p.ip.prefix}` : ""} [${p.roles.join(", ")}]`),
    ],
};
