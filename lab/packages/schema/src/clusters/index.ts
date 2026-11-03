import { z } from "zod";
import { ec2Cluster, Ec2ClusterInput, type ResolvedEc2Cluster } from "./ec2";
import { eksCluster, EksClusterInput, type ResolvedEksCluster } from "./eks";
import { harvesterCluster, HarvesterClusterInput, type ResolvedHarvesterCluster } from "./harvester";
import { k3kCluster, K3kClusterInput, type ResolvedK3kCluster } from "./k3k";
import { metalCluster, MetalClusterInput, type ResolvedMetalCluster } from "./metal";
import type { ClusterTypeName } from "./names";
import type { AwsFootprint, ClusterContext, ClusterType, RancherNeeds } from "./types";

// The downstream cluster types (DESIGN.md §5.5), one module each: its schema, how it's resolved
// and how `lab plan` shows it. A new type is a module here, its member in the union below and its
// entry in CLUSTER_TYPES; the program (program/clusters/) and the UI (ui/src/clusters.ts) have a
// table of their own, keyed the same way, so a type missing there fails to compile.

export { NODE_ROLES } from "./common";
export { CLUSTER_TYPE_NAMES, type ClusterTypeName } from "./names";
export type { AwsFootprint, ClusterContext, ClusterType } from "./types";
export type { ResolvedEc2Pool } from "./ec2";
export type { ResolvedEksNodeGroup } from "./eks";

export const DownstreamInput = z.discriminatedUnion("type", [HarvesterClusterInput, Ec2ClusterInput, EksClusterInput, MetalClusterInput, K3kClusterInput]);
export type DownstreamInput = z.infer<typeof DownstreamInput>;
/** A downstream cluster's `type`: each one is handled wherever clusters are (`assertNever` makes a missing one a compile error). */
export type DownstreamType = DownstreamInput["type"];

// The names the UI knows them by (names.ts) are these: a type added to one and not the other fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameNames: Same<DownstreamType, ClusterTypeName> = true;
void sameNames;

/** A downstream cluster as resolved by its type (before its profiles and Fleet outputs). */
export type ResolvedClusterOfType = ResolvedHarvesterCluster | ResolvedEc2Cluster | ResolvedEksCluster | ResolvedMetalCluster | ResolvedK3kCluster;

type TypeTable = { [T in DownstreamType]: ClusterType<Extract<DownstreamInput, { type: T }>, Extract<ResolvedClusterOfType, { type: T }>> };

/** A schema as JSON Schema (what a lab file may write), with its fields' form metadata (form.ts). */
export const formSchema = (schema: z.ZodType): unknown => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

/** Each cluster type's form schema: what the lab UI builds a cluster's form from. */
export function clusterFormSchemas(): Record<DownstreamType, unknown> {
    const inputs = { harvester: HarvesterClusterInput, ec2: Ec2ClusterInput, eks: EksClusterInput, metal: MetalClusterInput, k3k: K3kClusterInput };
    return Object.fromEntries(Object.entries(inputs).map(([type, schema]) => [type, formSchema(schema)])) as Record<DownstreamType, unknown>;
}

export const CLUSTER_TYPES: TypeTable = {
    harvester: harvesterCluster,
    ec2: ec2Cluster,
    eks: eksCluster,
    metal: metalCluster,
    k3k: k3kCluster,
};

/** A cluster's type module, for an input or resolved cluster of any type. */
const typeOf = (type: DownstreamType) => CLUSTER_TYPES[type] as unknown as ClusterType<DownstreamInput, ResolvedClusterOfType>;

/** Resolve a downstream cluster by its type. */
export const resolveCluster = (ctx: ClusterContext, name: string, d: DownstreamInput, at: string): ResolvedClusterOfType => typeOf(d.type).resolve(ctx, name, d, at);

/** A downstream cluster's lines in `lab plan`. */
export const planCluster = (d: ResolvedClusterOfType, meta: string): string[] => typeOf(d.type).plan(d, meta);

/** The OS profiles of a cluster's nodes, where the lab gives it nodes (see ClusterType.nodeOs). */
export const clusterNodeOs = (d: ResolvedClusterOfType, hostOs: (host: string) => string | undefined, at: string) => typeOf(d.type).nodeOs?.(d, hostOs, at) ?? [];

/** What a cluster has on AWS (its site, billed machines, what to check for leftovers); none for clusters elsewhere. */
export const awsFootprint = (d: ResolvedClusterOfType): AwsFootprint | undefined => typeOf(d.type).aws?.(d);

/** What a cluster type needs of its Rancher's host (`public-ingress`, for machines on AWS), if anything. */
export const rancherNeeds = (type: DownstreamType): RancherNeeds | undefined => CLUSTER_TYPES[type].rancherNeeds;
