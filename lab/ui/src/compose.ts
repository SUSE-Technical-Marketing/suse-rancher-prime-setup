// Building a lab from blocks: what a new Harvester, VM, Machine or cluster starts with, and what
// dropping a profile or a host does. The palette's clicks and the board's drops both use these.

import type { Block } from "./dnd";
import { addDoc, append, catalog, freeName, set, views } from "./store";

const k8sOs = () => catalog.value?.os.find(o => o.name.endsWith("-k8s"))?.name ?? "";
const plainOs = () => catalog.value?.os.find(o => !o.name.endsWith("-k8s"))?.name ?? "";
const hasSecret = (name: string) => !!catalog.value?.personal.secrets.some(s => s.name === name);
const firstOf = (kind: string) => views.value.find(v => v.kind === kind)?.metadata?.name ?? "";
const rancherHost = () => views.value.find(v => (v.kind === "HarvesterVM" || v.kind === "Machine") && v.spec?.profiles && "rancher" in v.spec.profiles)?.metadata?.name ?? "";

/** A profile's settings when it's added: what it can't do without, where the personal config has it. */
function profileDefaults(name: string): Record<string, unknown> {
    if (name === "rancher" && hasSecret("rancher-admin")) return { adminPassword: "{{ secrets['rancher-admin'] }}" };
    return {};
}

/** A Harvester's default network: where hosts and pools without a `network` go. */
export function defaultNetwork(harvester?: string): string {
    return views.value.find(v => v.kind === "Harvester" && v.metadata?.name === harvester)?.spec?.networks?.default ?? "untagged";
}

/** `network` for a host or pool on a Harvester: left out when it's the default. */
const networkOn = (harvester: string, network?: string) => (network && network !== defaultNetwork(harvester) ? { network } : {});

/** Add a block; `on` is the Harvester (and network lane) it was dropped on. */
export function addBlock(block: Block, on?: string, network?: string) {
    const harvester = on ?? firstOf("Harvester");
    const net = networkOn(harvester, network);
    switch (block) {
        case "Harvester":
            return addDoc("Harvester", freeName("Harvester", catalog.value?.personal.harvesters.find(h => !views.value.some(v => v.kind === "Harvester" && v.metadata?.name === h)) ?? "harvester"), { networks: { vlans: [] } });
        case "HarvesterVM":
            return addDoc("HarvesterVM", freeName("HarvesterVM", "vm"), { harvester, ...net, os: plainOs(), profiles: {} });
        case "RancherVM":
            return addDoc("HarvesterVM", freeName("HarvesterVM", "rancher"), {
                harvester, ...net, os: k8sOs(), memory: "16Gi", disk: "100Gi",
                profiles: { k3s: {}, "cert-manager": {}, sprouter: {}, traefik: {}, outrider: {}, rancher: profileDefaults("rancher") },
            });
        case "Machine":
            return addDoc("Machine", freeName("Machine", "machine"), { address: "", os: plainOs(), profiles: {} });
        case "DownstreamCluster":
            return addDoc("DownstreamCluster", freeName("DownstreamCluster", "cluster"), {
                type: "harvester", rancher: rancherHost(), harvester, distro: "rke2",
                pools: [{ name: "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], os: k8sOs(), ...net }],
            });
        case "K3kCluster":
            return addK3k(views.value.find(v => v.kind === "DownstreamCluster" && v.spec?.type !== "k3k")?.metadata?.name ?? "");
    }
}

/** A k3k cluster in a harvester or custom cluster, managed by the same Rancher. */
export function addK3k(parent: string) {
    const rancher = views.value.find(v => v.kind === "DownstreamCluster" && v.metadata?.name === parent)?.spec?.rancher ?? rancherHost();
    addDoc("DownstreamCluster", freeName("DownstreamCluster", "virtual"), { type: "k3k", rancher, parent });
}

/** A profile dropped on a host. k3s / RKE2 also move the host to its OS's -k8s variant. */
export function addProfile(index: number, name: string) {
    const host = views.value[index];
    if (!host || host.spec?.profiles?.[name]) return;
    set(index, ["spec", "profiles", name], profileDefaults(name));
    const distribution = catalog.value?.profiles.find(p => p.name === name)?.distribution;
    const os = host.spec?.os as string | undefined;
    if (distribution && os && !os.endsWith("-k8s") && catalog.value?.os.some(o => o.name === `${os}-k8s`)) {
        set(index, ["spec", "os"], `${os}-k8s`);
    }
}

export function removeProfile(index: number, name: string) {
    set(index, ["spec", "profiles", name], undefined);
}

/** A VM dropped on a network lane, of its Harvester or another one. */
export function moveVm(index: number, harvester: string, network: string) {
    const spec = views.value[index]?.spec ?? {};
    if (spec.harvester !== harvester) set(index, ["spec", "harvester"], harvester);
    const wanted = network === defaultNetwork(harvester) ? undefined : network;
    if (spec.network !== wanted) set(index, ["spec", "network"], wanted);
}

/** Where a host or a provisioned cluster's first pool sits: its Harvester and network. */
export function placeOf(index: number): { harvester?: string; network: string } {
    const v = views.value[index];
    const spec = v?.spec ?? {};
    const network = v?.kind === "DownstreamCluster" ? spec.pools?.[0]?.network : spec.network;
    return { harvester: spec.harvester, network: network ?? defaultNetwork(spec.harvester) };
}

/** A host dropped on a custom cluster: it joins as a node with every role. */
export function addNode(cluster: number, host: string) {
    const nodes: { host: string }[] = views.value[cluster]?.spec?.nodes ?? [];
    if (nodes.some(n => n.host === host)) return;
    append(cluster, ["spec", "nodes"], { host, roles: ["etcd", "controlplane", "worker"] });
}

/** Whether a host runs Kubernetes of its own (a custom cluster's nodes don't). */
export const runsKubernetes = (index: number) =>
    Object.keys(views.value[index]?.spec?.profiles ?? {}).some(n => catalog.value?.profiles.find(p => p.name === n)?.distribution);
