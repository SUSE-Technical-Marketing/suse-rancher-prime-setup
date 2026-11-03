import { z } from "zod";
import { form } from "../form";
import { annotations, checkDistro, checkPassthrough, checkRoles, ClusterPassthrough, distro, fleetProfiles, kubernetesVersion, labels, profiles, rancher, roles } from "./common";
import type { ClusterType } from "./types";

// Rancher installs Kubernetes on the lab's own hosts (Machines, bare VMs): Rancher's "custom" cluster.

export const MetalClusterInput = z.strictObject({
    /** Rancher installs Kubernetes on the lab's own hosts (Machines, bare VMs): Rancher's "custom" cluster. */
    type: z.literal("metal").meta(form({ section: "hidden" })),
    rancher,
    distro,
    version: kubernetesVersion,
    labels,
    annotations,
    fleetProfiles,
    profiles,
    ...ClusterPassthrough,
    nodes: z.array(z.strictObject({ host: z.string().meta(form({ options: "nodeHosts" })), roles })).min(1).meta(form({
        label: "Nodes", cards: { add: "a node", title: "host" },
        hint: "Hosts of this lab without Kubernetes of their own: Rancher installs it when they register.",
    })),
});
type Input = z.infer<typeof MetalClusterInput>;
export type ResolvedMetalCluster = Input & { name: string };

export const metalCluster: ClusterType<Input, ResolvedMetalCluster> = {
    resolve(ctx, name, d, at) {
        checkPassthrough(ctx, d, at);
        checkDistro(ctx, d.distro, at);
        d.nodes.forEach((node, i) => {
            const host = ctx.hosts.get(node.host);
            const nodeAt = `${at}.nodes[${i}].host`;
            if (!host) {
                ctx.error(nodeAt, `unknown host "${node.host}"`);
                return;
            }
            const owner = ctx.metalNodeOwner.get(node.host);
            if (owner) ctx.error(nodeAt, `host "${node.host}" is already a node of downstream cluster "${owner}"`);
            ctx.metalNodeOwner.set(node.host, name);
            const blocking = ctx.blocksMetalNode(host);
            if (blocking.length > 0) ctx.error(nodeAt, `host "${node.host}" can't join a metal cluster: it runs ${blocking.join(", ")}, which can't share a host with Kubernetes`);
        });
        checkRoles(ctx, d.nodes, at);
        return { ...d, name };
    },
    nodeOs: (d, hostOs, at) => d.nodes.flatMap(n => { const os = hostOs(n.host); return os ? [{ os, at: `${at} (node ${n.host})` }] : []; }),
    plan: (d, meta) => [
        `  ${d.name}  metal ${d.distro}, managed by Rancher on ${d.rancher}${meta}`,
        ...d.nodes.map(n => `    node ${n.host} [${n.roles.join(", ")}]`),
    ],
};
