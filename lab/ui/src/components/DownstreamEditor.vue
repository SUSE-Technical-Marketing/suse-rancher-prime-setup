<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { append, catalog, remove, views } from "../store";
import DocHeader from "./DocHeader.vue";
import KeyValue from "./KeyValue.vue";
import RolesField from "./RolesField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

// A cluster Rancher creates: VMs on a Harvester (pools), or a custom cluster on the lab's hosts.
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
/** A custom cluster's nodes: hosts without Kubernetes of their own. */
const nodeHosts = computed(() => hosts.value.filter(h => !Object.keys(h.spec?.profiles ?? {}).some(n => catalog.value?.profiles.find(p => p.name === n)?.distribution)).map(h => h.metadata?.name ?? ""));
const pools = computed<any[]>(() => spec.value.pools ?? []);
/** The fields each type has (the schema's DownstreamCluster variants); switching type drops the others. */
const FIELDS: Record<string, string[]> = {
  harvester: ["rancher", "harvester", "distro", "version", "labels", "annotations", "cni", "machineGlobalConfig", "chartValues", "secrets", "configmaps", "pools"],
  custom: ["rancher", "distro", "version", "labels", "annotations", "cni", "machineGlobalConfig", "chartValues", "secrets", "configmaps", "nodes"],
  k3k: ["rancher", "parent", "mode", "servers", "agents", "version", "namespace", "persistence", "labels", "annotations", "secrets", "configmaps"],
};
function setType(t: unknown) {
  const type = (t as string | undefined) ?? "harvester";
  for (const key of Object.keys(spec.value)) if (key !== "type" && !FIELDS[type].includes(key)) set(["spec", key], undefined);
  set("spec.type", type);
}

/** A k3k cluster's possible parents: the other harvester and custom clusters. */
const parents = computed(() => views.value.filter(d => d.kind === "DownstreamCluster" && d.spec?.type !== "k3k" && d.metadata?.name !== v.value.metadata?.name).map(d => d.metadata?.name ?? ""));
const nodes = computed<any[]>(() => spec.value.nodes ?? []);
const osHint = (os?: string) => (os && !os.endsWith("-k8s") && catalog.value?.os.some(o => o.name === `${os}-k8s`) ? `use ${os}-k8s for Kubernetes nodes` : undefined);

function addPool() {
  const k8s = catalog.value?.os.find(o => o.name.endsWith("-k8s"))?.name;
  append(props.index, ["spec", "pools"], { name: pools.value.length ? `pool-${pools.value.length + 1}` : "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], ...(k8s ? { os: k8s } : {}) });
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
        <SelectField label="type" :options="[{ value: 'harvester', label: 'harvester — VMs Rancher creates' }, { value: 'custom', label: 'custom — the lab\'s hosts join' }, { value: 'k3k', label: 'k3k — a virtual cluster in another' }]" required :model-value="spec.type" @update:model-value="setType" />
        <SelectField label="Rancher" required :options="ranchers" hint="a host with the rancher profile" v-bind="bind('spec.rancher')" />
        <SelectField v-if="type === 'harvester'" label="Harvester" required :options="harvesters" v-bind="bind('spec.harvester')" />
        <template v-if="type === 'k3k'">
          <SelectField label="parent" required :options="parents" hint="the harvester or custom cluster it runs in; same Rancher" v-bind="bind('spec.parent')" />
          <SelectField label="mode" :options="['shared', 'virtual', 'hcp']" empty="default shared" hint="shared: its workloads are pods of the parent; virtual: its own nodes, as pods" v-bind="bind('spec.mode')" />
          <TextField label="servers" number placeholder="default 1" v-bind="bind('spec.servers')" />
          <TextField label="agents" number placeholder="default 0" hint="virtual mode's nodes" v-bind="bind('spec.agents')" />
          <TextField label="k3s version" placeholder="default: the parent's Kubernetes" v-bind="bind('spec.version')" />
          <TextField label="namespace" :placeholder="`default k3k-${v.metadata?.name ?? ''}`" hint="on the parent" v-bind="bind('spec.namespace')" />
          <SelectField label="etcd" :options="[{ value: 'dynamic', label: 'dynamic — a PVC' }, { value: 'ephemeral', label: 'ephemeral' }]" empty="default dynamic" v-bind="bind('spec.persistence.type')" />
          <TextField v-if="spec.persistence?.type !== 'ephemeral'" label="storage class" placeholder="the parent's default" v-bind="bind('spec.persistence.storageClass')" />
          <TextField v-if="spec.persistence?.type !== 'ephemeral'" label="size" placeholder="default 2G" v-bind="bind('spec.persistence.size')" />
        </template>
        <template v-else>
          <SelectField label="distribution" :options="['rke2', 'k3s']" empty="default rke2" v-bind="bind('spec.distro')" />
          <TextField label="version" placeholder="default: the distribution's" v-bind="bind('spec.version')" />
          <TextField label="CNI" placeholder="default calico (RKE2), flannel (k3s)" v-bind="bind('spec.cni')" />
        </template>
      </div>
    </section>

    <section>
      <h3>Fleet</h3>
      <div class="grid">
        <KeyValue label="labels" hint="Fleet groups select on these; apps look for needs-traefik, needs-longhorn, needs-storage, needs-observability, …" v-bind="bind('spec.labels')" />
        <KeyValue label="annotations" hint="fleet.yaml reads them as .ClusterAnnotations, e.g. hosted-domain" v-bind="bind('spec.annotations')" />
      </div>
    </section>

    <section v-if="type === 'harvester'">
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
          <SelectField label="OS" required :options="osOptions" :hint="osHint(pool.os)" v-bind="bind(['spec', 'pools', i, 'os'])" />
          <TextField label="CPUs" number :placeholder="`default ${defaults?.cpu}`" v-bind="bind(['spec', 'pools', i, 'cpu'])" />
          <TextField label="memory" :placeholder="`default ${defaults?.memory}`" v-bind="bind(['spec', 'pools', i, 'memory'])" />
          <TextField label="disk" :placeholder="`default ${defaults?.disk}`" v-bind="bind(['spec', 'pools', i, 'disk'])" />
          <SelectField label="network" :options="networks" empty="the Harvester's default" v-bind="bind(['spec', 'pools', i, 'network'])" />
        </div>
      </div>
      <button type="button" class="link" @click="addPool">+ add a pool</button>
    </section>

    <section v-else-if="type === 'custom'">
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
        <template v-if="type !== 'k3k'">
          <YamlField label="machineGlobalConfig" hint="merged into the distribution's config on every node, e.g. disable: [traefik]" v-bind="bind('spec.machineGlobalConfig')" />
          <YamlField label="chartValues" hint="values for the distribution's bundled charts" v-bind="bind('spec.chartValues')" />
        </template>
        <YamlField label="secrets" hint="catalog secrets to create once the cluster is Ready" v-bind="bind('spec.secrets')" />
        <YamlField label="configmaps" v-bind="bind('spec.configmaps')" />
      </div>
    </details>
  </div>
</template>
