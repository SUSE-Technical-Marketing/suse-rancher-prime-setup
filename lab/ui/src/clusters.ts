import type { ClusterTypeName } from "../../packages/schema/src/clusters/names";
import type { Block } from "./dnd";
import type { Category } from "./kinds";

// The downstream cluster types as the composer shows them (DESIGN.md §5.5), keyed as the engine's
// (packages/schema/src/clusters/): a type missing here fails to compile. Everything the palette,
// the board and the cluster form need to know about one type is here.

type Spec = Record<string, any>;
/** The kinds of board box a cluster relates to. */
type BoxKind = "Harvester" | "AwsSite" | "HarvesterVM" | "Machine" | "DownstreamCluster";

/** What a new cluster is made from: what it was dropped on, and the lab's defaults. */
export interface NewCluster {
    /** The Harvester, AWS site, host or cluster it was dropped on, or the first that fits. */
    on: string;
    /** The lab's Rancher host. */
    rancher: string;
    /** The Rancher managing a cluster (a k3k cluster's parent's). */
    rancherOf(cluster: string): string;
    /** The network lane on a Harvester it was dropped on. */
    network: Spec;
    /** The default OS, and the first with an AMI (for EC2). */
    os?: string;
    ec2Os?: string;
}

/** The catalog's defaults a board tile shows where the cluster doesn't say. */
export interface TileDefaults {
    vm?: { cpu: number; memory: string };
    aws?: { instanceType: string; eksVersion: string };
}

export interface ClusterUi {
    /** Its palette block: what's dragged, its label and tooltip. */
    block: Block;
    label: string;
    hint: string;
    /** Its choice in the form's type select. */
    option: string;
    category: Extract<Category, "cluster" | "virtual">;
    icon: string;
    /** Its column on the board: 2 for clusters, 3 for those inside one. */
    column: number;
    /** A new one's name (made unique) and spec. */
    newName: string;
    create(c: NewCluster): Spec;
    /** The boxes its block can be dropped on (the first that fits when it's clicked or dropped on the board). */
    dropOn: BoxKind[];
    /** It can hold clusters that run inside another (k3k). */
    holdsNested?: boolean;
    /** Hosts dropped on it join as nodes. */
    takesNodes?: boolean;
    /** Its board box's label and line; the cluster's labels are its chips. */
    tile(s: Spec, title: string, d: TileDefaults): { label: string; sub: string };
    /** Its arrows to what it runs on or in: the box kinds to look in, the name, and the arrow's kind. */
    edges(s: Spec): { to: BoxKind[]; name: string | undefined; kind: "runs" | "inside" | "node" }[];
    /** The fields the engine's schema has for it: switching type drops the others. */
    fields: string[];
}

const ALL_ROLES = ["etcd", "controlplane", "worker"];
const PASSTHROUGH = ["cni", "machineGlobalConfig", "chartValues", "secrets", "configmaps"];

export const CLUSTER_UI: { [T in ClusterTypeName]: ClusterUi } = {
    harvester: {
        block: "DownstreamCluster",
        label: "Harvester cluster",
        hint: "a cluster Rancher creates from VMs on a Harvester: drop on a Harvester",
        option: "harvester — VMs Rancher creates",
        category: "cluster", icon: "ship-wheel", column: 2,
        newName: "cluster",
        create: c => ({
            type: "harvester", rancher: c.rancher, harvester: c.on, distro: "rke2",
            pools: [{ name: "all", quantity: 1, roles: ALL_ROLES, os: c.os, ...c.network }],
        }),
        dropOn: ["Harvester"],
        holdsNested: true,
        tile: (s, _t, d) => ({
            label: `harvester · ${s.distro ?? "rke2"}`,
            sub: ((s.pools ?? []) as Spec[]).map(p => `${p.quantity ?? 1}× ${p.cpu ?? d.vm?.cpu} CPU · ${p.memory ?? d.vm?.memory}`).join(", ") || "no pools",
        }),
        edges: s => [{ to: ["Harvester"], name: s.harvester, kind: "runs" }],
        fields: ["rancher", "harvester", "distro", "version", "labels", "annotations", ...PASSTHROUGH, "pools"],
    },
    ec2: {
        block: "Ec2Cluster",
        label: "EC2 cluster",
        hint: "machines Rancher creates on AWS (needs a public Rancher): drop on an AWS site",
        option: "ec2 — machines Rancher creates on AWS",
        category: "cluster", icon: "ship-wheel", column: 2,
        newName: "cloud",
        create: c => ({
            type: "ec2", rancher: c.rancher, site: c.on, distro: "rke2",
            pools: [{ name: "all", quantity: 1, roles: ALL_ROLES, os: c.ec2Os }],
        }),
        dropOn: ["AwsSite"],
        holdsNested: true,
        tile: (s, _t, d) => ({
            label: `ec2 · ${s.distro ?? "rke2"}`,
            sub: ((s.pools ?? []) as Spec[]).map(p => `${p.quantity ?? 1}× ${p.instanceType ?? d.aws?.instanceType}`).join(", ") || "no pools",
        }),
        edges: s => [{ to: ["AwsSite"], name: s.site, kind: "runs" }],
        fields: ["rancher", "site", "distro", "version", "labels", "annotations", ...PASSTHROUGH, "pools"],
    },
    eks: {
        block: "EksCluster",
        label: "EKS cluster",
        hint: "an EKS cluster Rancher creates and manages (needs a public Rancher): drop on an AWS site",
        option: "eks — an EKS cluster Rancher creates",
        category: "cluster", icon: "ship-wheel", column: 2,
        newName: "eks",
        create: c => ({ type: "eks", rancher: c.rancher, site: c.on, nodeGroups: [{ name: "general", quantity: 2 }] }),
        dropOn: ["AwsSite"],
        holdsNested: true,
        tile: (s, _t, d) => ({
            label: `eks · ${s.version ?? d.aws?.eksVersion}`,
            sub: ((s.nodeGroups ?? []) as Spec[]).map(g => `${g.quantity ?? 1}× ${g.instanceType ?? d.aws?.instanceType}`).join(", ") || "no node groups",
        }),
        edges: s => [{ to: ["AwsSite"], name: s.site, kind: "runs" }],
        fields: ["rancher", "site", "version", "labels", "annotations", "publicAccessSources", "logging", "secrets", "configmaps", "nodeGroups"],
    },
    metal: {
        block: "MetalCluster",
        label: "Metal cluster",
        hint: "Rancher installs Kubernetes on the lab's Machines or bare VMs: drop on one, then drop more on the cluster",
        option: "metal — Rancher installs Kubernetes on the lab's hosts",
        category: "cluster", icon: "ship-wheel", column: 2,
        newName: "metal",
        // Its first node: the host it was dropped on.
        create: c => ({ type: "metal", rancher: c.rancher, distro: "rke2", nodes: c.on ? [{ host: c.on, roles: ALL_ROLES }] : [] }),
        dropOn: ["HarvesterVM", "Machine"],
        holdsNested: true,
        takesNodes: true,
        tile: s => ({ label: `metal · ${s.distro ?? "rke2"}`, sub: `${(s.nodes ?? []).length} node(s)` }),
        edges: s => ((s.nodes ?? []) as { host?: string }[]).map(n => ({ to: ["HarvesterVM", "Machine"], name: n.host, kind: "node" })),
        fields: ["rancher", "distro", "version", "labels", "annotations", ...PASSTHROUGH, "nodes"],
    },
    k3k: {
        block: "K3kCluster",
        label: "k3k cluster",
        hint: "a virtual cluster inside another, imported into Rancher: drop on a cluster",
        option: "k3k — a virtual cluster in another",
        category: "virtual", icon: "boxes", column: 3,
        newName: "virtual",
        // Managed by the same Rancher as its parent.
        create: c => ({ type: "k3k", rancher: c.rancherOf(c.on), parent: c.on }),
        dropOn: ["DownstreamCluster"],
        tile: (s, title) => ({ label: `k3k · ${s.mode ?? "shared"}`, sub: `${s.servers ?? 1} server · ${s.agents ?? 0} agents · ${s.namespace ?? `k3k-${title}`}` }),
        edges: s => [{ to: ["DownstreamCluster"], name: s.parent, kind: "inside" }],
        fields: ["rancher", "parent", "mode", "servers", "agents", "version", "namespace", "persistence", "labels", "annotations", "secrets", "configmaps"],
    },
};

/** A downstream cluster document's type: the schema's default when it doesn't say. */
export const clusterType = (spec: { type?: string } | undefined): ClusterTypeName => {
    const t = spec?.type ?? "harvester";
    return t in CLUSTER_UI ? (t as ClusterTypeName) : "harvester";
};

/** The cluster type a palette block makes, if it makes one. */
export const clusterOfBlock = (block: Block): ClusterTypeName | undefined =>
    (Object.keys(CLUSTER_UI) as ClusterTypeName[]).find(t => CLUSTER_UI[t].block === block);
