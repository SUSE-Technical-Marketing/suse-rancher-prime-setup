import { z } from "zod";
import { dnsLabel, quantity } from "../primitives";
import { annotations, checkPassthrough, checkRoles, ClusterPassthrough, distro, fleetProfiles, labels, profiles, roles } from "./common";
import type { ClusterType } from "./types";

// A cluster Rancher creates from VMs on one of the lab's Harvesters, with its Harvester node driver.

const HarvesterPool = z.strictObject({
    name: dnsLabel,
    quantity: z.int().min(1),
    roles,
    /** Default: the catalog's Defaults (`vm`). */
    cpu: z.int().min(1).optional(),
    memory: quantity.optional(),
    disk: quantity.optional(),
    os: z.string().min(1),
    network: z.string().optional(),
});

export const HarvesterClusterInput = z.strictObject({
    type: z.literal("harvester"),
    rancher: z.string(),
    harvester: z.string(),
    distro,
    version: z.string().optional(),
    labels,
    annotations,
    fleetProfiles,
    profiles,
    ...ClusterPassthrough,
    pools: z.array(HarvesterPool).min(1),
});
type Input = z.infer<typeof HarvesterClusterInput>;

/** Its pools with their machine size filled in, and their networks checked. */
export type ResolvedHarvesterCluster = Omit<Input, "pools"> & { name: string; pools: (Input["pools"][number] & { cpu: number; memory: string; disk: string })[] };

export const harvesterCluster: ClusterType<Input, ResolvedHarvesterCluster> = {
    resolve(ctx, name, d, at) {
        checkPassthrough(ctx, d, at);
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
            const sized = { ...pool, cpu: pool.cpu ?? vm.cpu, memory: pool.memory ?? vm.memory, disk: pool.disk ?? vm.disk };
            if (!harvester) return sized;
            ctx.needImage(harvester.name, pool.os);
            return { ...sized, network: ctx.checkNetwork(harvester, pool.network, `${at}.pools[${i}].network`) };
        });
        checkRoles(ctx, d.pools, at);
        return { ...d, name, pools };
    },
    plan: (d, meta) => [
        `  ${d.name}  ${d.distro} on ${d.harvester}, managed by Rancher on ${d.rancher}${meta}`,
        ...d.pools.map(p => `    pool ${p.name}: ${p.quantity} × ${p.cpu} CPU / ${p.memory} / ${p.disk}, ${p.os}, network ${p.network} [${p.roles.join(", ")}]`),
    ],
};
