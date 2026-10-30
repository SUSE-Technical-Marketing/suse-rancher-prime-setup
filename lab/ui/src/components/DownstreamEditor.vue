<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { append, catalog, remove, views } from "../store";
import DocHeader from "./DocHeader.vue";
import KeyValue from "./KeyValue.vue";
import ListField from "./ListField.vue";
import RolesField from "./RolesField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

// A cluster Rancher creates: VMs on a Harvester or machines on EC2 (pools), an EKS cluster (node
// groups), a metal cluster on the lab's hosts, or a k3k cluster inside another.
const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
const spec = computed(() => v.value.spec ?? {});
const type = computed(() => spec.value.type ?? "harvester");
const defaults = computed(() => catalog.value?.defaults.vm);

const hosts = computed(() => views.value.filter(d => d.kind === "HarvesterVM" || d.kind === "Machine"));
const ranchers = computed(() => hosts.value.filter(h => h.spec?.profiles && "rancher" in h.spec.profiles).map(h => h.metadata?.name ?? ""));
const harvesters = computed(() => views.value.filter(d => d.kind === "Harvester").map(d => d.metadata?.name ?? ""));
const harvester = computed(() => views.value.find(d => d.kind === "Harvester" && d.metadata?.name === spec.value.harvester));
const networks = computed(() => ["untagged", ...((harvester.value?.spec?.networks?.vlans ?? []) as any[]).map(n => `vlan${n.id}`)]);
const osOptions = computed(() => (catalog.value?.os ?? []).map(o => o.name));
const sites = computed(() => views.value.filter(d => d.kind === "AwsSite").map(d => d.metadata?.name ?? ""));
const site = computed(() => views.value.find(d => d.kind === "AwsSite" && d.metadata?.name === spec.value.site));
const zones = computed<string[]>(() => site.value?.spec?.zones ?? catalog.value?.defaults.aws.zones ?? []);
/** EC2 machines boot an AMI: only OS profiles that name one. */
const amiOs = computed(() => (catalog.value?.os ?? []).filter(o => o.ami).map(o => o.name));
/** Whether the Rancher host can be reached from the internet: it needs a profile providing public-ingress. */
const rancherPublic = computed(() => {
  const host = hosts.value.find(h => h.metadata?.name === spec.value.rancher);
  return Object.keys(host?.spec?.profiles ?? {}).some(n => n === "public-ingress" || catalog.value?.profiles.find(p => p.name === n)?.provides.includes("public-ingress"));
});
const publicProfiles = computed(() => (catalog.value?.profiles ?? []).filter(p => p.name === "public-ingress" || p.provides.includes("public-ingress")).map(p => p.name));
/** A metal cluster's nodes: hosts without Kubernetes of their own. */
const nodeHosts = computed(() => hosts.value.filter(h => !Object.keys(h.spec?.profiles ?? {}).some(n => catalog.value?.profiles.find(p => p.name === n)?.distribution)).map(h => h.metadata?.name ?? ""));
const pools = computed<any[]>(() => spec.value.pools ?? []);
/** The fields each type has (the schema's DownstreamCluster variants); switching type drops the others. */
const FIELDS: Record<string, string[]> = {
  harvester: ["rancher", "harvester", "distro", "version", "labels", "annotations", "cni", "machineGlobalConfig", "chartValues", "secrets", "configmaps", "pools"],
  ec2: ["rancher", "site", "distro", "version", "labels", "annotations", "cni", "machineGlobalConfig", "chartValues", "secrets", "configmaps", "pools"],
  eks: ["rancher", "site", "version", "labels", "annotations", "publicAccessSources", "logging", "secrets", "configmaps", "nodeGroups"],
  metal: ["rancher", "distro", "version", "labels", "annotations", "cni", "machineGlobalConfig", "chartValues", "secrets", "configmaps", "nodes"],
  k3k: ["rancher", "parent", "mode", "servers", "agents", "version", "namespace", "persistence", "labels", "annotations", "secrets", "configmaps"],
};
/** A pool's fields per type: a Harvester VM's size and network, or an EC2 machine's. */
const POOL_FIELDS: Record<string, string[]> = {
  harvester: ["name", "quantity", "roles", "os", "cpu", "memory", "disk", "network"],
  ec2: ["name", "quantity", "roles", "os", "instanceType", "disk", "zone"],
};
function setType(t: unknown) {
  const type = (t as string | undefined) ?? "harvester";
  for (const key of Object.keys(spec.value)) if (key !== "type" && !FIELDS[type].includes(key)) set(["spec", key], undefined);
  // Pools carry over between harvester and ec2, without the other's fields.
  pools.value.forEach((pool, i) => {
    for (const key of Object.keys(pool)) if (POOL_FIELDS[type] && !POOL_FIELDS[type].includes(key)) set(["spec", "pools", i, key], undefined);
  });
  if ((type === "ec2" || type === "eks") && !spec.value.site && sites.value[0]) set("spec.site", sites.value[0]);
  // An EKS version is a minor of its own (1.34), not a distribution's.
  if (type === "eks" && spec.value.version && !/^1\.\d+$/.test(spec.value.version)) set("spec.version", undefined);
  if (type === "eks" && !spec.value.nodeGroups) set("spec.nodeGroups", [{ name: "general", quantity: 2 }]);
  set("spec.type", type);
}

/** A k3k cluster's possible parents: the other harvester, ec2, eks and metal clusters. */
const parents = computed(() => views.value.filter(d => d.kind === "DownstreamCluster" && d.spec?.type !== "k3k" && d.metadata?.name !== v.value.metadata?.name).map(d => d.metadata?.name ?? ""));
const nodes = computed<any[]>(() => spec.value.nodes ?? []);
const nodeGroups = computed<any[]>(() => spec.value.nodeGroups ?? []);
const onAws = computed(() => type.value === "ec2" || type.value === "eks");
/** Common sizes for lab nodes; any instance type works. */
const EC2_TYPES = ["t3.medium", "t3.large", "t3.xlarge", "t3.2xlarge", "m6i.large", "m6i.xlarge", "m6i.2xlarge", "c6i.xlarge", "r6i.xlarge"];

function addPool() {
  const os = catalog.value?.os.find(o => type.value !== "ec2" || o.ami)?.name;
  append(props.index, ["spec", "pools"], { name: pools.value.length ? `pool-${pools.value.length + 1}` : "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], ...(os ? { os } : {}) });
}
function addNodeGroup() {
  append(props.index, ["spec", "nodeGroups"], { name: nodeGroups.value.length ? `group-${nodeGroups.value.length + 1}` : "general", quantity: 2 });
}
function addNode() {
  append(props.index, ["spec", "nodes"], { host: nodeHosts.value[0] ?? "", roles: ["etcd", "controlplane", "worker"] });
}
</script>

<template>
  <div class="editor">
    <DocHeader kind="DownstreamCluster" :name="v.metadata?.name" name-hint="the cluster's name in Rancher" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Cluster</h3>
      <div class="grid">
        <SelectField label="type" :options="[{ value: 'harvester', label: 'harvester — VMs Rancher creates' }, { value: 'ec2', label: 'ec2 — machines Rancher creates on AWS' }, { value: 'eks', label: 'eks — an EKS cluster Rancher creates' }, { value: 'metal', label: 'metal — Rancher installs Kubernetes on the lab\'s hosts' }, { value: 'k3k', label: 'k3k — a virtual cluster in another' }]" required :model-value="spec.type" @update:model-value="setType" />
        <SelectField label="Rancher" required :options="ranchers" :hint="onAws ? 'a host with the rancher profile, reachable from the internet' : 'a host with the rancher profile'" v-bind="bind('spec.rancher')" />
        <SelectField v-if="type === 'harvester'" label="Harvester" required :options="harvesters" v-bind="bind('spec.harvester')" />
        <SelectField v-if="onAws" label="AWS site" required :options="sites" :hint="!sites.length ? 'add an AWS site first' : type === 'eks' ? 'it runs in the lab\'s VPC there, over two zones at least' : 'the machines go in the lab\'s VPC there'" v-bind="bind('spec.site')" />
        <template v-if="type === 'k3k'">
          <SelectField label="parent" required :options="parents" hint="the harvester, ec2, eks or metal cluster it runs in; same Rancher" v-bind="bind('spec.parent')" />
          <SelectField label="mode" :options="['shared', 'virtual', 'hcp']" empty="default shared" hint="shared: its workloads are pods of the parent; virtual: its own nodes, as pods" v-bind="bind('spec.mode')" />
          <TextField label="servers" number placeholder="default 1" v-bind="bind('spec.servers')" />
          <TextField label="agents" number placeholder="default 0" hint="virtual mode's nodes" v-bind="bind('spec.agents')" />
          <TextField label="k3s version" placeholder="default: the parent's Kubernetes" v-bind="bind('spec.version')" />
          <TextField label="namespace" :placeholder="`default k3k-${v.metadata?.name ?? ''}`" hint="on the parent" v-bind="bind('spec.namespace')" />
          <SelectField label="etcd" :options="[{ value: 'dynamic', label: 'dynamic — a PVC' }, { value: 'ephemeral', label: 'ephemeral' }]" empty="default dynamic" v-bind="bind('spec.persistence.type')" />
          <TextField v-if="spec.persistence?.type !== 'ephemeral'" label="storage class" placeholder="the parent's default" v-bind="bind('spec.persistence.storageClass')" />
          <TextField v-if="spec.persistence?.type !== 'ephemeral'" label="size" placeholder="default 2G" v-bind="bind('spec.persistence.size')" />
        </template>
        <template v-else-if="type === 'eks'">
          <TextField label="Kubernetes version" :placeholder="`default ${catalog?.defaults.aws.eksVersion}`" hint="an EKS minor, e.g. 1.34" v-bind="bind('spec.version')" />
        </template>
        <template v-else>
          <SelectField label="distribution" :options="['rke2', 'k3s']" empty="default rke2" v-bind="bind('spec.distro')" />
          <TextField label="version" placeholder="default: the distribution's" v-bind="bind('spec.version')" />
          <TextField label="CNI" placeholder="default calico (RKE2), flannel (k3s)" v-bind="bind('spec.cni')" />
        </template>
      </div>
    </section>

    <p v-if="onAws && spec.rancher && !rancherPublic" class="warn-text notice">
      {{ type === "eks" ? "An EKS cluster's agent registers" : "EC2 machines register" }} with Rancher over the internet, and {{ spec.rancher }} isn't public:
      <template v-if="publicProfiles.length">give it {{ publicProfiles.join(" or ") }}.</template>
      <template v-else>no profile makes a Rancher public yet (the Cloudflare tunnel's public-ingress is coming). You can compose and save this cluster; validation keeps rejecting it until then.</template>
    </p>

    <section>
      <h3>Fleet</h3>
      <div class="grid">
        <KeyValue label="labels" hint="Fleet groups select on these; apps look for needs-traefik, needs-longhorn, needs-storage, needs-observability, …" v-bind="bind('spec.labels')" />
        <KeyValue label="annotations" hint="fleet.yaml reads them as .ClusterAnnotations, e.g. hosted-domain: {{ lab.domain }}" v-bind="bind('spec.annotations')" />
      </div>
    </section>

    <section v-if="type === 'harvester' || type === 'ec2'">
      <h3>Machine pools</h3>
      <div v-for="(pool, i) in pools" :key="i" class="card">
        <header>
          <strong>{{ pool.name || "pool" }}</strong>
          <button type="button" class="icon" title="Remove pool" @click="remove(index, ['spec', 'pools', i])">×</button>
        </header>
        <div class="grid">
          <TextField label="name" required v-bind="bind(['spec', 'pools', i, 'name'])" />
          <TextField label="quantity" number required v-bind="bind(['spec', 'pools', i, 'quantity'])" />
          <RolesField v-bind="bind(['spec', 'pools', i, 'roles'])" />
          <template v-if="type === 'ec2'">
            <SelectField label="OS" required :options="amiOs" hint="OS profiles with an AMI" v-bind="bind(['spec', 'pools', i, 'os'])" />
            <TextField label="instance type" :placeholder="`default ${catalog?.defaults.aws.instanceType}`" list="ec2-types" v-bind="bind(['spec', 'pools', i, 'instanceType'])" />
            <TextField label="disk" :placeholder="`default ${defaults?.disk}`" hint="root volume, gp3" v-bind="bind(['spec', 'pools', i, 'disk'])" />
            <SelectField label="zone" :options="zones" :empty="`the site's first (${zones[0] ?? 'a'})`" v-bind="bind(['spec', 'pools', i, 'zone'])" />
          </template>
          <template v-else>
            <SelectField label="OS" required :options="osOptions" v-bind="bind(['spec', 'pools', i, 'os'])" />
            <TextField label="CPUs" number :placeholder="`default ${defaults?.cpu}`" v-bind="bind(['spec', 'pools', i, 'cpu'])" />
            <TextField label="memory" :placeholder="`default ${defaults?.memory}`" v-bind="bind(['spec', 'pools', i, 'memory'])" />
            <TextField label="disk" :placeholder="`default ${defaults?.disk}`" v-bind="bind(['spec', 'pools', i, 'disk'])" />
            <SelectField label="network" :options="networks" empty="the Harvester's default" v-bind="bind(['spec', 'pools', i, 'network'])" />
          </template>
        </div>
      </div>
      <button type="button" class="link" @click="addPool">+ add a pool</button>
      <datalist id="ec2-types"><option v-for="t in EC2_TYPES" :key="t" :value="t" /></datalist>
    </section>

    <section v-else-if="type === 'eks'">
      <h3>Node groups</h3>
      <p class="muted">EKS managed node groups. Rancher creates the IAM roles for the cluster and its nodes; the nodes get no lab login.</p>
      <div v-for="(group, i) in nodeGroups" :key="i" class="card">
        <header>
          <strong>{{ group.name || "node group" }}</strong>
          <button type="button" class="icon" title="Remove node group" @click="remove(index, ['spec', 'nodeGroups', i])">×</button>
        </header>
        <div class="grid">
          <TextField label="name" required v-bind="bind(['spec', 'nodeGroups', i, 'name'])" />
          <TextField label="quantity" number required hint="nodes it starts with" v-bind="bind(['spec', 'nodeGroups', i, 'quantity'])" />
          <TextField label="min" number :placeholder="`default ${group.quantity ?? 1}`" v-bind="bind(['spec', 'nodeGroups', i, 'min'])" />
          <TextField label="max" number :placeholder="`default ${group.quantity ?? 1}`" v-bind="bind(['spec', 'nodeGroups', i, 'max'])" />
          <TextField label="instance type" :placeholder="`default ${catalog?.defaults.aws.instanceType}`" list="ec2-types" hint="Graviton types (m7g, t4g) get the arm64 image" v-bind="bind(['spec', 'nodeGroups', i, 'instanceType'])" />
          <TextField label="disk" :placeholder="`default ${defaults?.disk}`" v-bind="bind(['spec', 'nodeGroups', i, 'disk'])" />
          <ListField label="zones" :placeholder="`default all: ${zones.join(', ')}`" hint="by letter" v-bind="bind(['spec', 'nodeGroups', i, 'zones'])" />
          <KeyValue label="node labels" v-bind="bind(['spec', 'nodeGroups', i, 'labels'])" />
        </div>
      </div>
      <button type="button" class="link" @click="addNodeGroup">+ add a node group</button>
      <datalist id="ec2-types"><option v-for="t in EC2_TYPES" :key="t" :value="t" /></datalist>
    </section>

    <section v-else-if="type === 'metal'">
      <h3>Nodes</h3>
      <p class="muted">Hosts of this lab without Kubernetes of their own: Rancher installs it when they register.</p>
      <div v-for="(node, i) in nodes" :key="i" class="card">
        <header>
          <strong>{{ node.host || "node" }}</strong>
          <button type="button" class="icon" title="Remove node" @click="remove(index, ['spec', 'nodes', i])">×</button>
        </header>
        <div class="grid">
          <SelectField label="host" required :options="nodeHosts" v-bind="bind(['spec', 'nodes', i, 'host'])" />
          <RolesField v-bind="bind(['spec', 'nodes', i, 'roles'])" />
        </div>
      </div>
      <button type="button" class="link" @click="addNode">+ add a node</button>
    </section>

    <details class="advanced">
      <summary>More</summary>
      <div class="grid">
        <template v-if="type === 'eks'">
          <ListField label="API access from" format="cidr" placeholder="default anywhere (0.0.0.0/0)" hint="CIDRs that may reach the EKS API endpoint directly; Rancher's proxy works regardless" v-bind="bind('spec.publicAccessSources')" />
          <ListField label="control plane logs" placeholder="none" hint="to CloudWatch: api, audit, authenticator, controllerManager, scheduler" v-bind="bind('spec.logging')" />
        </template>
        <template v-else-if="type !== 'k3k'">
          <YamlField label="machineGlobalConfig" hint="merged into the distribution's config on every node, e.g. disable: [traefik]" v-bind="bind('spec.machineGlobalConfig')" />
          <YamlField label="chartValues" hint="values for the distribution's bundled charts" v-bind="bind('spec.chartValues')" />
        </template>
        <YamlField label="secrets" hint="catalog secrets to create once the cluster is Ready" v-bind="bind('spec.secrets')" />
        <YamlField label="configmaps" v-bind="bind('spec.configmaps')" />
      </div>
    </details>
  </div>
</template>
