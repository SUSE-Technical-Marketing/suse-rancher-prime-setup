import { z } from "zod";
import { form } from "../form";
import { awsZone, dnsLabel, quantity } from "../primitives";
import { annotations, checkDistro, checkPassthrough, checkRoles, ClusterPassthrough, distro, fleetProfiles, stackPacks, kubernetesVersion, labels, profiles, rancher, roles } from "./common";

/** Common sizes for lab nodes, suggested in the lab UI; any instance type works. */
export const EC2_TYPES = ["t3.medium", "t3.large", "t3.xlarge", "t3.2xlarge", "m6i.large", "m6i.xlarge", "m6i.2xlarge", "c6i.xlarge", "r6i.xlarge"];
import type { ClusterType } from "./types";

// Machines Rancher creates on EC2 with its node driver, in an AWS site's VPC.

const Ec2Pool = z.strictObject({
    name: dnsLabel,
    quantity: z.int().min(1),
    roles,
    os: z.string().min(1).meta(form({ label: "OS", options: "amiOs", hint: "OS profiles with an AMI" })),
    /** Default: the catalog's Defaults (`aws.instanceType`). */
    instanceType: z.string().min(1).optional().meta(form({ label: "instance type", suggestions: EC2_TYPES, placeholder: "default {defaults.aws.instanceType}" })),
    /** Root volume; default the catalog's Defaults (`vm.disk`). */
    disk: quantity.optional().meta(form({ hint: "root volume, gp3", placeholder: "default {defaults.vm.disk}" })),
    /** Its availability zone, by letter; default the site's first. */
    zone: awsZone.optional().meta(form({ options: "zones", placeholder: "the site's first ({zones.0})" })),
});

export const Ec2ClusterInput = z.strictObject({
    /** Machines Rancher creates on EC2 with its node driver, in the site's VPC (§5.5). */
    type: z.literal("ec2").meta(form({ section: "hidden" })),
    rancher,
    /** The AwsSite its machines go in. */
    site: z.string().meta(form({ label: "AWS site", options: "sites", hint: "the machines go in the lab's VPC there" })),
    distro,
    version: kubernetesVersion,
    labels,
    annotations,
    fleetProfiles,
    stackPacks,
    profiles,
    ...ClusterPassthrough,
    pools: z.array(Ec2Pool).min(1).meta(form({ label: "Machine pools", cards: { add: "a pool", title: "name" } })),
});
type Input = z.infer<typeof Ec2ClusterInput>;

/** An EC2 pool with its defaults filled in. */
export type ResolvedEc2Pool = Input["pools"][number] & { instanceType: string; disk: string; zone: string };
export type ResolvedEc2Cluster = Omit<Input, "pools"> & { name: string; pools: ResolvedEc2Pool[] };

export const ec2Cluster: ClusterType<Input, ResolvedEc2Cluster> = {
    rancherNeeds: { capability: "public-ingress", because: "EC2 machines reach Rancher over the internet" },
    resolve(ctx, name, d, at) {
        checkPassthrough(ctx, d, at);
        checkDistro(ctx, d.distro, at);
        const site = ctx.awsSites.get(d.site);
        if (!site) ctx.error(`${at}.site`, `unknown AwsSite "${d.site}"; known: ${[...ctx.awsSites.keys()].sort().join(", ") || "none (add an AwsSite document)"}`);
        const poolNames = new Set<string>();
        const pools = d.pools.map((pool, i) => {
            const poolAt = `${at}.pools[${i}]`;
            if (poolNames.has(pool.name)) ctx.error(`${poolAt}.name`, `pool "${pool.name}" is defined twice`);
            poolNames.add(pool.name);
            const os = ctx.useOs(pool.os, `${poolAt}.os`);
            if (os && !os.ami) ctx.error(`${poolAt}.os`, `OS profile ${pool.os} has no AMI (ami: owner and name) to boot EC2 machines from`);
            const zone = pool.zone ?? site?.zones[0]?.letter ?? "a";
            if (site && !site.zones.some(z => z.letter === zone)) {
                ctx.error(`${poolAt}.zone`, `the site ${site.name} has no subnet in zone ${zone}; its zones: ${site.zones.map(z => z.letter).join(", ")}`);
            }
            return { ...pool, instanceType: pool.instanceType ?? ctx.defaults.aws.instanceType, disk: pool.disk ?? ctx.defaults.vm.disk, zone };
        });
        checkRoles(ctx, d.pools, at);
        return { ...d, name, pools };
    },
    aws: d => ({
        site: d.site,
        machines: d.pools.map(p => ({ instanceType: p.instanceType, quantity: p.quantity })),
        controlPlanes: 0,
        keyPairPrefixes: [`${d.name}-`],
        eksClusters: [],
    }),
    nodeOs: d => d.pools.map((p, i) => ({ os: p.os, at: `downstream.${d.name}.pools[${i}].os` })),
    plan: (d, meta) => [
        `  ${d.name}  ${d.distro} on EC2 (${d.site}), managed by Rancher on ${d.rancher}${meta}`,
        ...d.pools.map(p => `    pool ${p.name}: ${p.quantity} × ${p.instanceType} / ${p.disk}, ${p.os}, zone ${p.zone} [${p.roles.join(", ")}]`),
    ],
};
