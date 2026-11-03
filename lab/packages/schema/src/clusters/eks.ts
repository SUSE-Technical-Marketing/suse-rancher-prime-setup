import { z } from "zod";
import { form } from "../form";
import { awsZone, cidr, dnsLabel, quantity } from "../primitives";
import { annotations, fleetProfiles, labels, placements, profiles, rancher } from "./common";
import { EC2_TYPES } from "./ec2";
import type { ClusterType } from "./types";

// An EKS cluster Rancher creates and manages (hosted), in an AWS site's VPC.

const EksNodeGroup = z.strictObject({
    name: dnsLabel,
    /** Nodes it starts with; it scales between min and max (default both this). */
    quantity: z.int().min(1).meta(form({ hint: "nodes it starts with" })),
    min: z.int().min(0).optional().meta(form({ placeholder: "default {item.quantity}" })),
    max: z.int().min(1).optional().meta(form({ placeholder: "default {item.quantity}" })),
    /** Default: the catalog's Defaults (`aws.instanceType`). */
    instanceType: z.string().min(1).optional().meta(form({
        label: "instance type", suggestions: EC2_TYPES, hint: "Graviton types (m7g, t4g) get the arm64 image", placeholder: "default {defaults.aws.instanceType}",
    })),
    /** Each node's volume; default the catalog's Defaults (`vm.disk`). */
    disk: quantity.optional().meta(form({ placeholder: "default {defaults.vm.disk}" })),
    /** Its availability zones, by letter; default all of the site's. */
    zones: z.array(awsZone).min(1).optional().meta(form({ hint: "by letter", placeholder: "default all: {zones}" })),
    /** Kubernetes labels on its nodes. */
    labels: z.record(z.string(), z.string()).optional().meta(form({ label: "node labels" })),
});

export const EksClusterInput = z.strictObject({
    /** An EKS cluster Rancher creates and manages (hosted), in the site's VPC (§5.5). */
    type: z.literal("eks").meta(form({ section: "hidden" })),
    rancher,
    /** The AwsSite whose VPC it runs in; it needs two zones at least. */
    site: z.string().meta(form({ label: "AWS site", options: "sites", hint: "it runs in the lab's VPC there, over two zones at least" })),
    /** EKS Kubernetes minor (1.34); default the catalog's Defaults (`aws.eksVersion`). */
    version: z.string().regex(/^1\.\d+$/, "an EKS minor such as 1.34").optional()
        .meta(form({ label: "Kubernetes version", hint: "an EKS minor, e.g. 1.34", placeholder: "default {defaults.aws.eksVersion}" })),
    labels,
    annotations,
    fleetProfiles,
    profiles,
    /** Who may reach its API endpoint besides Rancher's proxy; default anyone. */
    publicAccessSources: z.array(cidr).optional().meta(form({
        section: "advanced", label: "API access from", placeholder: "default anywhere (0.0.0.0/0)",
        hint: "CIDRs that may reach the EKS API endpoint directly; Rancher's proxy works regardless",
    })),
    /** Control plane logs sent to CloudWatch: api, audit, authenticator, controllerManager, scheduler. */
    logging: z.array(z.enum(["api", "audit", "authenticator", "controllerManager", "scheduler"])).optional()
        .meta(form({ section: "advanced", label: "control plane logs", placeholder: "none", hint: "to CloudWatch: api, audit, authenticator, controllerManager, scheduler" })),
    ...placements,
    nodeGroups: z.array(EksNodeGroup).min(1).meta(form({
        label: "Node groups", cards: { add: "a node group", title: "name" },
        hint: "EKS managed node groups. Rancher creates the IAM roles for the cluster and its nodes; the nodes get no lab login.",
    })),
});
type Input = z.infer<typeof EksClusterInput>;

/** An EKS node group with its defaults filled in. */
export type ResolvedEksNodeGroup = Input["nodeGroups"][number] & { min: number; max: number; instanceType: string; disk: string; zones: string[] };
export type ResolvedEksCluster = Omit<Input, "nodeGroups" | "version"> & { name: string; version: string; nodeGroups: ResolvedEksNodeGroup[] };

export const eksCluster: ClusterType<Input, ResolvedEksCluster> = {
    rancherNeeds: { capability: "public-ingress", because: "An EKS cluster's agent reaches Rancher over the internet" },
    resolve(ctx, name, d, at) {
        const site = ctx.awsSites.get(d.site);
        if (!site) ctx.error(`${at}.site`, `unknown AwsSite "${d.site}"; known: ${[...ctx.awsSites.keys()].sort().join(", ") || "none (add an AwsSite document)"}`);
        else if (site.zones.length < 2) ctx.error(`${at}.site`, `EKS needs subnets in two zones at least, and the site ${site.name} has ${site.zones.length}`);
        const groupNames = new Set<string>();
        const nodeGroups = d.nodeGroups.map((g, i) => {
            const groupAt = `${at}.nodeGroups[${i}]`;
            if (groupNames.has(g.name)) ctx.error(`${groupAt}.name`, `node group "${g.name}" is defined twice`);
            groupNames.add(g.name);
            const min = g.min ?? g.quantity;
            const max = g.max ?? Math.max(g.quantity, min);
            if (min > g.quantity || g.quantity > max) ctx.error(`${groupAt}.quantity`, `${g.quantity} isn't between min ${min} and max ${max}`);
            const zones = g.zones ?? site?.zones.map(z => z.letter) ?? [];
            for (const zone of zones) {
                if (site && !site.zones.some(z => z.letter === zone)) {
                    ctx.error(`${groupAt}.zones`, `the site ${site.name} has no subnet in zone ${zone}; its zones: ${site.zones.map(z => z.letter).join(", ")}`);
                }
            }
            return { ...g, min, max, instanceType: g.instanceType ?? ctx.defaults.aws.instanceType, disk: g.disk ?? ctx.defaults.vm.disk, zones };
        });
        return { ...d, name, version: d.version ?? ctx.defaults.aws.eksVersion, nodeGroups };
    },
    aws: d => ({
        site: d.site,
        machines: d.nodeGroups.map(g => ({ instanceType: g.instanceType, quantity: g.quantity })),
        controlPlanes: 1,
        keyPairPrefixes: [],
        eksClusters: [d.name],
    }),
    plan: (d, meta) => [
        `  ${d.name}  EKS ${d.version} (${d.site}), created and managed by Rancher on ${d.rancher}${meta}`,
        ...d.nodeGroups.map(g => `    node group ${g.name}: ${g.min === g.max ? `${g.quantity}` : `${g.quantity} (${g.min}–${g.max})`} × ${g.instanceType} / ${g.disk}, zones ${g.zones.join(", ")}`),
    ],
};
