import { CLUSTER_UI, clusterType } from "./clusters";
import type { Block } from "./dnd";

// What the lab is made of, in three kinds the palette groups and the board draws alike: where
// things run (a Harvester, an AWS site), the machines (VMs, existing machines), and the Kubernetes
// clusters Rancher creates (k3k ones, inside another, are a shade of their own).

export type Category = "infra" | "machine" | "cluster" | "virtual";

export const CATEGORIES: { id: Exclude<Category, "virtual">; label: string; hint: string }[] = [
    { id: "infra", label: "Infrastructure", hint: "where machines and clusters run" },
    { id: "machine", label: "Machines", hint: "VMs and existing machines; profiles go on these" },
    { id: "cluster", label: "Kubernetes clusters", hint: "clusters Rancher creates and manages" },
];

/** A document's category and icon (a Lucide name); none for the Lab and catalog overrides. */
export function kindOf(kind?: string, type?: string): { category: Category; icon: string } | undefined {
    switch (kind) {
        case "Harvester": return { category: "infra", icon: "server-cog" };
        case "AwsSite": return { category: "infra", icon: "cloud" };
        case "HarvesterVM": return { category: "machine", icon: "monitor" };
        case "Machine": return { category: "machine", icon: "server" };
        case "DownstreamCluster": {
            const ui = CLUSTER_UI[clusterType({ type })];
            return { category: ui.category, icon: ui.icon };
        }
        default: return undefined;
    }
}

/** A palette block's category and icon; a cluster type's from its descriptor (clusters.ts). */
export const BLOCK_KIND = {
    Harvester: { category: "infra", icon: "server-cog" },
    AwsSite: { category: "infra", icon: "cloud" },
    HarvesterVM: { category: "machine", icon: "monitor" },
    Machine: { category: "machine", icon: "server" },
    ...Object.fromEntries(Object.values(CLUSTER_UI).map(ui => [ui.block, { category: ui.category, icon: ui.icon }])),
} as Record<Block, { category: Category; icon: string }>;
