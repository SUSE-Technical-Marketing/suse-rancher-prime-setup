import type { ResolvedDownstream } from "@lab/schema";
import { ec2 } from "./ec2";
import { eks } from "./eks";
import { harvester } from "./harvester";
import { k3k } from "./k3k";
import { metal } from "./metal";
import type { BuiltCluster, ClusterBuildContext, ClusterBuilder, ClusterBuilders } from "./types";

// How the program builds each downstream cluster type (DESIGN.md §5.5), keyed as the schema's
// cluster types (packages/schema/src/clusters/): a type missing here fails to compile.

export type { BuiltCluster, ClusterBuildContext, ClusterNode } from "./types";

export const CLUSTER_BUILDERS: ClusterBuilders = { harvester, ec2, eks, metal, k3k };

const builderOf = (d: ResolvedDownstream) => CLUSTER_BUILDERS[d.type] as ClusterBuilder<ResolvedDownstream>;

/** Whether a cluster runs in another one, and is built once the others are. */
export const isNested = (d: ResolvedDownstream): boolean => !!builderOf(d).nested;

/** Build a downstream cluster by its type. */
export const buildCluster = (ctx: ClusterBuildContext, d: ResolvedDownstream): BuiltCluster => builderOf(d).build(ctx, d);
