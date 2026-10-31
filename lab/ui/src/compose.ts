// Building a lab from blocks: what a new Harvester, AWS site, VM, Machine or cluster starts with, and what
// dropping a profile or a host does. The palette's clicks and the board's drops both use these.

import type { Block } from "./dnd";
import { secretTemplate } from "./secrets";
import { addDoc, append, catalog, freeName, set, views } from "./store";

/** The OS new hosts and pools get; the engine adds what Harvester and Kubernetes need to it. */
const defaultOs = () => catalog.value?.os[0]?.name ?? "";
/** An OS that boots on EC2 (has an AMI). */
const ec2Os = () => catalog.value?.os.find(o => o.ami)?.name ?? "";
const hasSecret = (name: string) => !!catalog.value?.personal.secrets.some(s => s.name === name);
const firstOf = (kind: string) => views.value.find(v => v.kind === kind)?.metadata?.name ?? "";
const rancherHost = () => views.value.find(v => (v.kind === "HarvesterVM" || v.kind === "Machine") && v.spec?.profiles && "rancher" in v.spec.profiles)?.metadata?.name ?? "";

/** A profile's settings when it's added: what it can't do without, where the personal config has it. */
function profileDefaults(name: string): Record<string, unknown> {
    if (name === "rancher" && hasSecret("rancher-admin")) return { adminPassword: "{{ secrets['rancher-admin'] }}" };
    // SUSE AI Factory: the Application Collection, SCC (the SUSE registry) and NGC logins, where the personal config has them.
    if (name === "ai-factory") {
        return {
            ...(hasSecret("appco") ? { applicationCollection: "{{ secrets.appco }}" } : {}),
            ...(hasSecret("scc") ? { suseRegistry: "{{ secrets.scc }}" } : {}),
            ...(hasSecret("nvidia") ? { nvidia: "{{ secrets.nvidia }}" } : {}),
        };
    }
    return {};
}

/** A Harvester's default network: where hosts and pools without a `network` go. */
export function defaultNetwork(harvester?: string): string {
    return views.value.find(v => v.kind === "Harvester" && v.metadata?.name === harvester)?.spec?.networks?.default ?? "untagged";
}

/** `network` for a host or pool on a Harvester: left out when it's the default. */
const networkOn = (harvester: string, network?: string) => (network && network !== defaultNetwork(harvester) ? { network } : {});

/**
 * Add the host a catalog HostRecipe describes: its size, OS (default the composer's) and profiles,
 * each profile's settings over what the personal config can fill in (Rancher's admin password). A
 * VM goes on `on` (the Harvester, and network lane, it was dropped on) or the first Harvester.
 */
export function addRecipe(name: string, on?: string, network?: string) {
    const r = catalog.value?.recipes.find(x => x.name === name);
    if (!r) return;
    const { profiles, os, ...size } = r.host;
    const host = {
        os: os ?? defaultOs(),
        profiles: Object.fromEntries(Object.entries(profiles).map(([p, settings]) => [p, { ...profileDefaults(p), ...settings }])),
    };
    if (r.kind === "Machine") return addDoc("Machine", freeName("Machine", r.hostName), { address: "", ...host });
    const harvester = on ?? firstOf("Harvester");
    return addDoc("HarvesterVM", freeName("HarvesterVM", r.hostName), { harvester, ...networkOn(harvester, network), ...size, ...host });
}

/** Add a block; `on` is the Harvester (and network lane) or AWS site it was dropped on. */
export function addBlock(block: Block, on?: string, network?: string) {
    const harvester = on ?? firstOf("Harvester");
    const net = networkOn(harvester, network);
    switch (block) {
        case "Harvester":
            return addDoc("Harvester", freeName("Harvester", catalog.value?.personal.harvesters.find(h => !views.value.some(v => v.kind === "Harvester" && v.metadata?.name === h)) ?? "harvester"), { networks: { vlans: [] } });
        case "HarvesterVM":
            return addDoc("HarvesterVM", freeName("HarvesterVM", "vm"), { harvester, ...net, os: defaultOs(), profiles: {} });
        case "Machine":
            return addDoc("Machine", freeName("Machine", "machine"), { address: "", os: defaultOs(), profiles: {} });
        case "DownstreamCluster":
            return addDoc("DownstreamCluster", freeName("DownstreamCluster", "cluster"), {
                type: "harvester", rancher: rancherHost(), harvester, distro: "rke2",
                pools: [{ name: "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], os: defaultOs(), ...net }],
            });
        case "AwsSite": {
            const mine = catalog.value?.personal.awsSites.find(s => !views.value.some(v => v.kind === "AwsSite" && v.metadata?.name === s.name));
            // Not in the personal config: the first secret there holding AWS keys, if any.
            const keys = catalog.value?.personal.secrets.find(s => s.fields?.includes("accessKey") && s.fields.includes("secretKey"))?.path;
            return addDoc("AwsSite", freeName("AwsSite", mine?.name ?? "aws"), mine || !keys ? {} : { credentials: secretTemplate(keys) });
        }
        case "Ec2Cluster":
            return addDoc("DownstreamCluster", freeName("DownstreamCluster", "cloud"), {
                type: "ec2", rancher: rancherHost(), site: on ?? firstOf("AwsSite"), distro: "rke2",
                pools: [{ name: "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], os: ec2Os() }],
            });
        case "EksCluster":
            return addDoc("DownstreamCluster", freeName("DownstreamCluster", "eks"), {
                type: "eks", rancher: rancherHost(), site: on ?? firstOf("AwsSite"),
                nodeGroups: [{ name: "general", quantity: 2 }],
            });
        case "MetalCluster": {
            // Its first node: the host it was dropped on, or the first one that can be one.
            const host = on ?? views.value.find((v, i) => (v.kind === "Machine" || v.kind === "HarvesterVM") && canBeNode(i))?.metadata?.name;
            return addDoc("DownstreamCluster", freeName("DownstreamCluster", "metal"), {
                type: "metal", rancher: rancherHost(), distro: "rke2",
                nodes: host ? [{ host, roles: ["etcd", "controlplane", "worker"] }] : [],
            });
        }
        case "K3kCluster":
            return addK3k(views.value.find(v => v.kind === "DownstreamCluster" && v.spec?.type !== "k3k")?.metadata?.name ?? "");
    }
}

/** A k3k cluster in a harvester, ec2, eks or metal cluster, managed by the same Rancher. */
export function addK3k(parent: string) {
    const rancher = views.value.find(v => v.kind === "DownstreamCluster" && v.metadata?.name === parent)?.spec?.rancher ?? rancherHost();
    addDoc("DownstreamCluster", freeName("DownstreamCluster", "virtual"), { type: "k3k", rancher, parent });
}

/** A profile dropped on a host, or a ChartProfile on a downstream cluster. */
export function addProfile(index: number, name: string) {
    const host = views.value[index];
    if (!host || host.spec?.profiles?.[name]) return;
    set(index, ["spec", "profiles", name], profileDefaults(name));
}



export function removeProfile(index: number, name: string) {
    set(index, ["spec", "profiles", name], undefined);
}

/** A host dropped on a metal cluster: it joins as a node with every role. */
export function addNode(cluster: number, host: string) {
    const nodes: { host: string }[] = views.value[cluster]?.spec?.nodes ?? [];
    if (nodes.some(n => n.host === host)) return;
    append(cluster, ["spec", "nodes"], { host, roles: ["etcd", "controlplane", "worker"] });
}

/** Whether a host runs Kubernetes of its own (a metal cluster's nodes don't). */
export const runsKubernetes = (index: number) =>
    Object.keys(views.value[index]?.spec?.profiles ?? {}).some(n => catalog.value?.profiles.find(p => p.name === n)?.distribution);

/** Whether a host can join a metal cluster: no Kubernetes of its own, and in no metal cluster yet. */
export function canBeNode(index: number): boolean {
    const name = views.value[index]?.metadata?.name;
    return !runsKubernetes(index) && !views.value.some(d => d.kind === "DownstreamCluster" && d.spec?.type === "metal" && (d.spec?.nodes ?? []).some((n: { host?: string }) => n.host === name));
}

/** A Fleet profile dropped on a downstream cluster: its labels and annotations go on the cluster. */
export function addFleetProfile(index: number, name: string) {
    if (views.value[index]?.spec?.fleetProfiles?.[name]) return;
    set(index, ["spec", "fleetProfiles", name], {});
}

export function removeFleetProfile(index: number, name: string) {
    set(index, ["spec", "fleetProfiles", name], undefined);
}
