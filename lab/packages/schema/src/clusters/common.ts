import { z } from "zod";
import { Placement } from "../objects";
import type { ClusterContext } from "./types";

// What the downstream cluster types (DESIGN.md §5.5) share: their schemas' common fields, and the
// checks every cluster whose machines Rancher provisions gets.

export const NODE_ROLES = ["etcd", "controlplane", "worker"] as const;
export const roles = z.array(z.enum(NODE_ROLES)).min(1);
export const labels = z.record(z.string(), z.string()).default({});
/** On the provisioning Cluster; Rancher copies them to the Fleet cluster (`.ClusterAnnotations` in fleet.yaml). */
export const annotations = z.record(z.string(), z.string()).default({});
/** Fleet profiles (§16.3) by name: their labels and annotations go on the cluster, and Fleet installs what they select. */
export const fleetProfiles = z.record(z.string().min(1), z.strictObject({})).default({});
/** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
export const profiles = z.record(z.string(), z.record(z.string(), z.unknown())).default({});
export const distro = z.enum(["rke2", "k3s"]).default("rke2");

/** Rancher cluster settings beyond the engine's (§16.5): passed through, merged over the engine's. */
export const ClusterPassthrough = {
    /** CNI; default calico for RKE2, flannel for k3s. */
    cni: z.string().min(1).optional(),
    /** Merged into `rkeConfig.machineGlobalConfig` (the distro's config.yaml on every node). */
    machineGlobalConfig: z.record(z.string(), z.unknown()).optional(),
    /** Merged into `rkeConfig.chartValues` (values for the distro's bundled charts). */
    chartValues: z.record(z.string(), z.unknown()).optional(),
    /** Catalog secrets and configmaps to create on the cluster once it is Ready (§16.6). */
    secrets: z.array(Placement).optional(),
    configmaps: z.array(Placement).optional(),
};

/** The engine owns the CNI key: a cluster sets it with `cni`. */
export function checkPassthrough(ctx: ClusterContext, d: { machineGlobalConfig?: Record<string, unknown> }, at: string): void {
    if (d.machineGlobalConfig && "cni" in d.machineGlobalConfig) ctx.error(`${at}.machineGlobalConfig.cni`, "set it with downstream cni instead");
}

/** A cluster needs a node with each role. */
export function checkRoles(ctx: ClusterContext, nodes: { roles: readonly string[] }[], at: string): void {
    const all = new Set(nodes.flatMap(n => n.roles));
    const missing = NODE_ROLES.filter(r => !all.has(r));
    if (missing.length > 0) ctx.error(at, `no node has the ${missing.join(", ")} role${missing.length > 1 ? "s" : ""}; a cluster needs at least one of each`);
}

