import { z } from "zod";
import { Placement } from "../objects";
import { dnsLabel, quantity } from "../primitives";
import { annotations, fleetProfiles, labels, profiles } from "./common";
import type { ClusterType } from "./types";

// A k3k virtual cluster inside another downstream cluster, imported into Rancher.

export const K3kClusterInput = z.strictObject({
    /** A k3k virtual cluster inside another downstream cluster, imported into Rancher (§5.5). */
    type: z.literal("k3k"),
    rancher: z.string(),
    /** The DownstreamCluster it runs in; the engine installs the k3k operator there. */
    parent: z.string(),
    /** shared: its workloads are pods of the parent; virtual: it has its own nodes, as pods; hcp: hosted control plane. */
    mode: z.enum(["shared", "virtual", "hcp"]).default("shared"),
    servers: z.int().min(1).default(1),
    agents: z.int().min(0).default(0),
    /** Its k3s version (v1.33.1-k3s1); default the parent's Kubernetes version. */
    version: z.string().optional(),
    /** Namespace on the parent; default `k3k-<name>`. */
    namespace: dnsLabel.optional(),
    /** etcd data: on a PVC (`dynamic`, the parent's default StorageClass unless `storageClass`) or `ephemeral`. */
    persistence: z.strictObject({
        type: z.enum(["dynamic", "ephemeral"]).default("dynamic"),
        storageClass: z.string().min(1).optional(),
        size: quantity.optional(),
    }).optional(),
    labels,
    annotations,
    fleetProfiles,
    profiles,
    secrets: z.array(Placement).optional(),
    configmaps: z.array(Placement).optional(),
});
type Input = z.infer<typeof K3kClusterInput>;
export type ResolvedK3kCluster = Input & { name: string };

export const k3kCluster: ClusterType<Input, ResolvedK3kCluster> = {
    resolve(ctx, name, d, at) {
        const parent = ctx.inputs[d.parent];
        if (!parent) ctx.error(`${at}.parent`, `unknown downstream cluster "${d.parent}"; known: ${Object.keys(ctx.inputs).filter(n => n !== name).sort().join(", ") || "none"}`);
        else if (parent.type === "k3k") ctx.error(`${at}.parent`, `"${d.parent}" is a k3k cluster itself; a k3k cluster runs in a harvester, ec2, eks or metal cluster`);
        else if (parent.rancher !== d.rancher) ctx.error(`${at}.parent`, `"${d.parent}" is managed by the Rancher on ${parent.rancher}, this cluster by the one on ${d.rancher}; they must be the same`);
        return { ...d, name, namespace: d.namespace ?? `k3k-${name}` };
    },
    plan(d, meta) {
        const persistence = d.persistence?.type === "ephemeral" ? "ephemeral" : `etcd on a ${d.persistence?.size ?? "default-size"} PVC (${d.persistence?.storageClass ?? "default StorageClass"})`;
        return [
            `  ${d.name}  k3k ${d.mode} in ${d.parent} (namespace ${d.namespace}), managed by Rancher on ${d.rancher}${meta}`,
            `    ${d.servers} server${d.servers > 1 ? "s" : ""}, ${d.agents} agent${d.agents === 1 ? "" : "s"}, k3s ${d.version ?? "as the parent"}, ${persistence}`,
        ];
    },
};
