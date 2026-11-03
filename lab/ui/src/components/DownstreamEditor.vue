<script setup lang="ts">
import { computed, provide } from "vue";
import { useDoc } from "../doc";
import { catalog, reportOf, views } from "../store";
import { addFleetProfile, defaultDistro, removeFleetProfile } from "../compose";
import { CLUSTER_UI, clusterType } from "../clusters";
import { FORM_CONTEXT } from "../form";
import type { ClusterTypeName } from "../../../packages/schema/src/clusters/names";
import DocHeader from "./DocHeader.vue";
import ProfileIcon from "./ProfileIcon.vue";
import ProfilesEditor from "./ProfilesEditor.vue";
import SchemaForm from "./SchemaForm.vue";
import SelectField from "./SelectField.vue";

// A cluster Rancher creates: VMs on a Harvester or machines on EC2 (pools), an EKS cluster (node
// groups), a metal cluster on the lab's hosts, or a k3k cluster inside another. Its fields come
// from its type's schema (SchemaForm); here are the lab's lists they choose from, and what isn't a
// field: the type, the Rancher notice, Fleet profiles and ChartProfiles.
const props = defineProps<{ index: number }>();
const { v, set } = useDoc(() => props.index);
const spec = computed(() => v.value.spec ?? {});
const type = computed(() => clusterType(spec.value));
const schema = computed(() => catalog.value?.clusterForms[type.value] ?? {});

const hosts = computed(() => views.value.filter(d => d.kind === "HarvesterVM" || d.kind === "Machine"));
const names = (kind: string) => views.value.filter(d => d.kind === kind).map(d => d.metadata?.name ?? "");
const harvester = computed(() => views.value.find(d => d.kind === "Harvester" && d.metadata?.name === spec.value.harvester));
const site = computed(() => views.value.find(d => d.kind === "AwsSite" && d.metadata?.name === spec.value.site));
const zones = computed<string[]>(() => site.value?.spec?.zones ?? catalog.value?.defaults.aws.zones ?? []);
const distros = computed(() => catalog.value?.distributions ?? []);
/** What the cluster's type needs of its Rancher's host (public-ingress, for machines on AWS), whether it has it, and what gives it. */
const rancherNeeds = computed(() => catalog.value?.rancherNeeds[type.value]);
const rancherHasIt = computed(() => {
  const host = views.value.findIndex(h => (h.kind === "HarvesterVM" || h.kind === "Machine") && h.metadata?.name === spec.value.rancher);
  return !rancherNeeds.value || (host >= 0 && !!reportOf(host)?.provided.includes(rancherNeeds.value.capability));
});
const neededProfiles = computed(() => {
  const cap = rancherNeeds.value?.capability;
  return (catalog.value?.profiles ?? []).filter(p => p.status !== "planned" && (p.name === cap || p.provides.includes(cap ?? ""))).map(p => p.name);
});
/** A metal cluster's nodes: hosts without Kubernetes of their own. */
const nodeHosts = computed(() => hosts.value.filter(h => !Object.keys(h.spec?.profiles ?? {}).some(n => catalog.value?.profiles.find(p => p.name === n)?.distribution)).map(h => h.metadata?.name ?? ""));
/** A k3k cluster's possible parents: the other clusters that hold nested ones. */
const parents = computed(() => views.value.filter(d => d.kind === "DownstreamCluster" && CLUSTER_UI[clusterType(d.spec)].holdsNested && d.metadata?.name !== v.value.metadata?.name).map(d => d.metadata?.name ?? ""));

provide(FORM_CONTEXT, () => ({
  options: {
    ranchers: hosts.value.filter(h => h.spec?.profiles && "rancher" in h.spec.profiles).map(h => h.metadata?.name ?? ""),
    harvesters: names("Harvester"),
    sites: names("AwsSite"),
    parents: parents.value,
    nodeHosts: nodeHosts.value,
    distros: distros.value.map(d => d.name),
    osProfiles: (catalog.value?.os ?? []).map(o => o.name),
    /** EC2 machines boot an AMI: only OS profiles that name one. */
    amiOs: (catalog.value?.os ?? []).filter(o => o.ami).map(o => o.name),
    networks: ["untagged", ...((harvester.value?.spec?.networks?.vlans ?? []) as any[]).map(n => `vlan${n.id}`)],
    zones: zones.value,
  },
  vars: {
    defaults: catalog.value?.defaults,
    name: v.value.metadata?.name ?? "",
    distro: defaultDistro(),
    cnis: distros.value.map(d => `${d.cni} (${d.name})`).join(", "),
    zones: zones.value,
    rancherNeeds: rancherNeeds.value ? ` and ${rancherNeeds.value.capability}` : "",
  },
}));

/** The type select's choices, one per cluster type. */
const TYPES = (Object.keys(CLUSTER_UI) as ClusterTypeName[]).map(t => ({ value: t, label: CLUSTER_UI[t].option }));
const fieldsOf = (s: { properties?: Record<string, unknown> } | undefined) => Object.keys(s?.properties ?? {});
function setType(t: unknown) {
  const type = clusterType({ type: t as string | undefined });
  const next = catalog.value?.clusterForms[type];
  // The fields its schema has; switching type drops the others.
  for (const key of Object.keys(spec.value)) if (key !== "type" && !fieldsOf(next).includes(key)) set(["spec", key], undefined);
  // Pools carry over between harvester and ec2, without the other's fields.
  const poolFields = fieldsOf(next?.properties?.pools?.items);
  ((spec.value.pools ?? []) as Record<string, unknown>[]).forEach((pool, i) => {
    for (const key of Object.keys(pool)) if (poolFields.length && !poolFields.includes(key)) set(["spec", "pools", i, key], undefined);
  });
  const firstSite = names("AwsSite")[0];
  if ((type === "ec2" || type === "eks") && !spec.value.site && firstSite) set("spec.site", firstSite);
  // An EKS version is a minor of its own (1.34), not a distribution's.
  if (type === "eks" && spec.value.version && !/^1\.\d+$/.test(spec.value.version)) set("spec.version", undefined);
  if (type === "eks" && !spec.value.nodeGroups) set("spec.nodeGroups", [{ name: "general", quantity: 2 }]);
  set("spec.type", type);
}

/** A new card's fields: a pool, node group or node. */
function newItem(field: string): Record<string, unknown> {
  const count = ((spec.value[field] ?? []) as unknown[]).length;
  if (field === "nodeGroups") return { name: count ? `group-${count + 1}` : "general", quantity: 2 };
  if (field === "nodes") return { host: nodeHosts.value[0] ?? "", roles: ["etcd", "controlplane", "worker"] };
  const os = catalog.value?.os.find(o => type.value !== "ec2" || o.ami)?.name;
  return { name: count ? `pool-${count + 1}` : "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], ...(os ? { os } : {}) };
}

/** The cluster's Fleet profiles, and the others it can add. */
const fleetNames = computed(() => Object.keys(spec.value.fleetProfiles ?? {}));
const fleetChoices = computed(() => (catalog.value?.fleetProfiles ?? []).filter(p => !fleetNames.value.includes(p.name)));
const fleetInfo = (name: string) => {
  const p = catalog.value?.fleetProfiles.find(x => x.name === name);
  return p ? `${p.description}\nlabels: ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(", ")}` : "not in the catalog";
};
function addFleet(e: Event) {
  const select = e.target as HTMLSelectElement;
  if (select.value) addFleetProfile(props.index, select.value);
  select.value = "";
}
</script>

<template>
  <div class="editor">
    <DocHeader kind="DownstreamCluster" :name="v.metadata?.name" name-hint="the cluster's name in Rancher" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Cluster</h3>
      <SchemaForm :index="index" :schema="schema" section="main">
        <SelectField label="type" :options="TYPES" required :model-value="spec.type" @update:model-value="setType" />
      </SchemaForm>
    </section>

    <p v-if="rancherNeeds && spec.rancher && !rancherHasIt" class="warn-text notice">
      {{ rancherNeeds.because }}, and {{ spec.rancher }} doesn't have {{ rancherNeeds.capability }}:
      <template v-if="neededProfiles.length">give it {{ neededProfiles.join(" or ") }}.</template>
      <template v-else>no profile in the catalog provides it yet. You can compose and save this cluster; validation keeps rejecting it until then.</template>
    </p>

    <SchemaForm :index="index" :schema="schema" section="cards" :new-item="newItem" />

    <section>
      <h3>Fleet</h3>
      <p class="muted">Fleet profiles put their labels and annotations on the cluster; Fleet installs what they select. Drop them on the cluster box, or add them here.</p>
      <div class="fleet-profiles">
        <span v-for="p in fleetNames" :key="p" class="fleet-chip" :title="fleetInfo(p)">
          <ProfileIcon :name="p" :size="20" fleet />{{ p }}
          <button type="button" class="icon" :title="`Remove ${p}`" @click="removeFleetProfile(index, p)">×</button>
        </span>
        <select v-if="fleetChoices.length" class="fleet-add" :value="''" @change="addFleet">
          <option value="" disabled>+ add a Fleet profile</option>
          <option v-for="p in fleetChoices" :key="p.name" :value="p.name">{{ p.name }} — {{ p.description }}</option>
        </select>
      </div>
      <SchemaForm :index="index" :schema="schema" section="fleet" />
    </section>

    <ProfilesEditor :index="index" :model-value="spec.profiles" target="cluster" @set="(n, x) => set(['spec', 'profiles', n], x ?? {})" @remove="n => set(['spec', 'profiles', n], undefined)" />

    <details class="advanced">
      <summary>More</summary>
      <SchemaForm :index="index" :schema="schema" section="advanced" />
    </details>
  </div>
</template>
