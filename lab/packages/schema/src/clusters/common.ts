import { z } from "zod";
import { form } from "../form";
import { Placement } from "../objects";
import type { ClusterContext } from "./types";

// What the downstream cluster types (DESIGN.md §5.5) share: their schemas' common fields, and the
// checks every cluster whose machines Rancher provisions gets.

export const NODE_ROLES = ["etcd", "controlplane", "worker"] as const;
export const roles = z.array(z.enum(NODE_ROLES)).min(1).meta(form({ widget: "roles" }));
export const labels = z.record(z.string(), z.string()).default({})
    .meta(form({ section: "fleet", hint: "more labels of your own: Fleet groups select on them too" }));
/** On the provisioning Cluster; Rancher copies them to the Fleet cluster (`.ClusterAnnotations` in fleet.yaml). */
export const annotations = z.record(z.string(), z.string()).default({})
    .meta(form({ section: "fleet", hint: "fleet.yaml reads them as .ClusterAnnotations, e.g. hosted-domain: {{ lab.domain }}" }));
/** Fleet profiles (§16.3) by name: their labels and annotations go on the cluster, and Fleet installs what they select. */
export const fleetProfiles = z.record(z.string().min(1), z.strictObject({})).default({}).meta(form({ section: "hidden" }));
/**
 * StackPacks (catalog StackPack documents) on the SUSE Observability this cluster runs (a Fleet profile
 * providing suse-observability), installed with its bootstrap token (§9.6); one taken out is uninstalled.
 */
export const stackPacks = z.array(z.string().min(1)).optional().meta(form({ section: "hidden" }));
/** ChartProfiles by name, with their settings: installed by the engine once the cluster is ready (§17). */
export const profiles = z.record(z.string(), z.record(z.string(), z.unknown())).default({}).meta(form({ section: "hidden" }));
/** The host running the Rancher that manages it. */
export const rancher = z.string().meta(form({ label: "Rancher", options: "ranchers", hint: "a host with the rancher profile{rancherNeeds}" }));
/** A KubernetesDistribution in the catalog (`rke2`, `k3s`), checked by `checkDistro`. */
export const DEFAULT_DISTRO = "rke2";
export const distro = z.string().min(1).default(DEFAULT_DISTRO).meta(form({ label: "distribution", options: "distros", placeholder: "default {distro}" }));
/** Its Kubernetes version; default the distribution's. */
export const kubernetesVersion = z.string().optional().meta(form({ placeholder: "default: the distribution's" }));
/** Catalog secrets and configmaps to create on the cluster once it is Ready (§16.6). */
export const placements = {
    secrets: z.array(Placement).optional().meta(form({ section: "advanced", hint: "catalog secrets to create once the cluster is Ready" })),
    configmaps: z.array(Placement).optional().meta(form({ section: "advanced" })),
};

/** Rancher cluster settings beyond the engine's (§16.5): passed through, merged over the engine's. */
export const ClusterPassthrough = {
    /** CNI; default the distribution's `cni` (calico for RKE2, flannel for k3s). */
    cni: z.string().min(1).optional().meta(form({ label: "CNI", placeholder: "default {cnis}" })),
    /** Merged into `rkeConfig.machineGlobalConfig` (the distro's config.yaml on every node). */
    machineGlobalConfig: z.record(z.string(), z.unknown()).optional()
        .meta(form({ section: "advanced", hint: "merged into the distribution's config on every node, e.g. disable: [traefik]" })),
    /** Merged into `rkeConfig.chartValues` (values for the distro's bundled charts). */
    chartValues: z.record(z.string(), z.unknown()).optional().meta(form({ section: "advanced", hint: "values for the distribution's bundled charts" })),
    ...placements,
};

/** The cluster's distribution must be a KubernetesDistribution in the catalog. */
export function checkDistro(ctx: ClusterContext, distro: string, at: string): void {
    if (!ctx.distributions.includes(distro)) ctx.error(`${at}.distro`, `no KubernetesDistribution "${distro}"; known: ${ctx.distributions.join(", ") || "none"}`);
}

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

