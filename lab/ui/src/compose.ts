// Building a lab from blocks: what a new Harvester, AWS site, VM, Machine or cluster starts with, and what
// dropping a profile or a host does. The palette's clicks and the board's drops both use these.

import { CLUSTER_UI, clusterOfBlock, clusterType } from "./clusters";
import type { ClusterTypeName } from "../../packages/schema/src/clusters/names";
import type { Block } from "./dnd";
import { secretPath, secretTemplate } from "./secrets";
import { addDoc, append, catalog, freeName, reportOf, set, views } from "./store";

/** The OS new hosts and pools get; the engine adds what Harvester and Kubernetes need to it. */
const defaultOs = () => catalog.value?.os[0]?.name ?? "";
/** An OS that boots on EC2 (has an AMI). */
const ec2Os = () => catalog.value?.os.find(o => o.ami)?.name ?? "";
export const defaultDistro = () => catalog.value?.distributions.find(d => d.default)?.name ?? "";
const hasSecret = (name: string) => !!catalog.value?.personal.secrets.some(s => s.name === name);
const firstOf = (kind: string) => views.value.find(v => v.kind === kind)?.metadata?.name ?? "";
const rancherHost = () => views.value.find(v => (v.kind === "HarvesterVM" || v.kind === "Machine") && v.spec?.profiles && "rancher" in v.spec.profiles)?.metadata?.name ?? "";

/** A profile's settings when it's added: what it can't do without, where the personal config has it. */
/** The lab's downstream clusters that provide a capability, as the engine judged them (SUSE Observability's observers). */
export function clustersProviding(capability: string): string[] {
    return views.value.flatMap((v, i) => v.kind === "DownstreamCluster" && v.metadata?.name && reportOf(i)?.provided.includes(capability) ? [String(v.metadata.name)] : []);
}

export function profileDefaults(name: string): Record<string, unknown> {
    // A setting naming a cluster (the agent's observer): the one cluster that qualifies, if there is one.
    const profile = catalog.value?.profiles.find(p => p.name === name);
    const refs = profile?.clusterRefs ?? [];
    const picked = Object.fromEntries(refs.flatMap(r => {
        const options = clustersProviding(r.provides);
        return options.length === 1 && !r.field.includes(".") ? [[r.field, options[0]]] : [];
    }));
    // Settings that suggest a secret template (Rancher's admin password), where the personal config has the secret.
    const suggested = Object.entries(profile?.settings.properties ?? {}).flatMap(([field, s]) => {
        const path = secretPath(s.suggest);
        return path && hasSecret(path.join(".")) ? [[field, s.suggest]] : [];
    });
    return { ...picked, ...Object.fromEntries(suggested) };
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
    const type = clusterOfBlock(block);
    if (type) return addCluster(type, on, network);
    const harvester = on ?? firstOf("Harvester");
    const net = networkOn(harvester, network);
    switch (block) {
        case "Harvester":
            return addDoc("Harvester", freeName("Harvester", catalog.value?.personal.harvesters.find(h => !views.value.some(v => v.kind === "Harvester" && v.metadata?.name === h)) ?? "harvester"), { networks: { vlans: [] } });
        case "HarvesterVM":
            return addDoc("HarvesterVM", freeName("HarvesterVM", "vm"), { harvester, ...net, os: defaultOs(), profiles: {} });
        case "Machine":
            return addDoc("Machine", freeName("Machine", "machine"), { address: "", os: defaultOs(), profiles: {} });
        case "AwsSite": {
            const mine = catalog.value?.personal.awsSites.find(s => !views.value.some(v => v.kind === "AwsSite" && v.metadata?.name === s.name));
            // Not in the personal config: the first secret there holding AWS keys, if any.
            const keys = catalog.value?.personal.secrets.find(s => s.fields?.includes("accessKey") && s.fields.includes("secretKey"))?.path;
            return addDoc("AwsSite", freeName("AwsSite", mine?.name ?? "aws"), mine || !keys ? {} : { credentials: secretTemplate(keys) });
        }
        default:
            return undefined;
    }
}

/** Whether a box (document) can take a cluster of this type: a host that can be a node, a cluster that holds nested ones. */
function fits(type: ClusterTypeName, index: number): boolean {
    const v = views.value[index];
    if (!v?.kind || !(CLUSTER_UI[type].dropOn as string[]).includes(v.kind)) return false;
    if (v.kind === "HarvesterVM" || v.kind === "Machine") return canBeNode(index);
    if (v.kind === "DownstreamCluster") return !!CLUSTER_UI[clusterType(v.spec)].holdsNested;
    return true;
}

/** A cluster of a type, on what it was dropped on (`on`), or the first document it fits. */
export function addCluster(type: ClusterTypeName, on?: string, network?: string) {
    const target = on ?? views.value.find((v, i) => fits(type, i))?.metadata?.name ?? "";
    const ui = CLUSTER_UI[type];
    return addDoc("DownstreamCluster", freeName("DownstreamCluster", ui.newName), ui.create({
        on: target,
        rancher: rancherHost(),
        rancherOf: cluster => views.value.find(v => v.kind === "DownstreamCluster" && v.metadata?.name === cluster)?.spec?.rancher ?? rancherHost(),
        network: type === "harvester" ? networkOn(target, network) : {},
        os: defaultOs(),
        ec2Os: ec2Os(),
        distro: defaultDistro(),
    }));
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

/** Whether a downstream cluster runs SUSE Observability: one of its Fleet profiles provides it. */
export const runsObservability = (index: number) => Object.keys(views.value[index]?.spec?.fleetProfiles ?? {})
    .some(n => catalog.value?.fleetProfiles.find(p => p.name === n)?.provides.includes("suse-observability"));

/** A StackPack dropped on a cluster running SUSE Observability: added to its `stackPacks`. */
export function addStackPack(index: number, name: string) {
    const list: string[] = views.value[index]?.spec?.stackPacks ?? [];
    if (list.includes(name)) return;
    set(index, ["spec", "stackPacks"], [...list, name]);
}

export function removeStackPack(index: number, name: string) {
    const list = ((views.value[index]?.spec?.stackPacks ?? []) as string[]).filter(n => n !== name);
    set(index, ["spec", "stackPacks"], list.length > 0 ? list : undefined);
}
