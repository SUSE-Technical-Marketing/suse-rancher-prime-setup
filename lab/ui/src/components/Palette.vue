<script setup lang="ts">
import ProfileIcon from "./ProfileIcon.vue";
import KindIcon from "./KindIcon.vue";
import { computed, ref } from "vue";
import { addBlock, addRecipe, removeFleetProfile, removeProfile } from "../compose";
import { dragging, end, start, target, type Block, type Payload } from "../dnd";
import { BLOCK_KIND, CATEGORIES } from "../kinds";
import { catalog } from "../store";

// Building blocks, by category, and two kinds of profiles to drag onto the board: profiles the engine
// installs on a host, and Fleet profiles, labels and annotations for a downstream cluster that Fleet
// installs from. A block can also be clicked: it goes on the first Harvester or AWS site. A profile
// dragged back here comes off its host or cluster.
const BLOCKS: { block: Block; label: string; hint: string }[] = [
  { block: "Harvester", label: "Harvester", hint: "a Harvester the lab uses: drop on the board" },
  { block: "HarvesterVM", label: "VM", hint: "a VM: drop on a Harvester" },
  { block: "Machine", label: "Machine", hint: "an existing machine, reached over SSH: drop on the board" },
  { block: "DownstreamCluster", label: "Harvester cluster", hint: "a cluster Rancher creates from VMs on a Harvester: drop on a Harvester" },
  { block: "AwsSite", label: "AWS site", hint: "an AWS account and region; the lab gets its own VPC there: drop on the board" },
  { block: "Ec2Cluster", label: "EC2 cluster", hint: "machines Rancher creates on AWS (needs a public Rancher): drop on an AWS site" },
  { block: "EksCluster", label: "EKS cluster", hint: "an EKS cluster Rancher creates and manages (needs a public Rancher): drop on an AWS site" },
  { block: "MetalCluster", label: "Metal cluster", hint: "Rancher installs Kubernetes on the lab's Machines or bare VMs: drop on one, then drop more on the cluster" },
  { block: "K3kCluster", label: "k3k cluster", hint: "a virtual cluster inside another, imported into Rancher: drop on a cluster" },
];

/** One palette entry: a block, or a catalog HostRecipe (a standard host), as it's drawn and dragged. */
interface Entry { key: string; label: string; hint: string; icon: string; cls: string[]; payload: Payload; add: () => void }
const blockEntry = (b: (typeof BLOCKS)[number]): Entry => ({
  key: b.block, label: b.label, hint: b.hint, icon: BLOCK_KIND[b.block].icon,
  cls: [`cat-${BLOCK_KIND[b.block].category}`, `blk-${b.block}`],
  payload: { type: "block", block: b.block }, add: () => addBlock(b.block),
});
/** HostRecipes come right after the block of their kind (VM or Machine). */
const recipesOf = (kind: "HarvesterVM" | "Machine"): Entry[] => (catalog.value?.recipes ?? []).filter(r => r.kind === kind).map(r => ({
  key: `recipe-${r.name}`, label: r.label,
  hint: `${r.description || r.label}${r.kind === "HarvesterVM" ? "" : ": drop on the board"}\nprofiles: ${Object.keys(r.host.profiles).join(", ") || "none"}\n(HostRecipe ${r.name})`,
  icon: r.icon ?? BLOCK_KIND[kind].icon, cls: ["cat-machine", "recipe"],
  payload: { type: "recipe", name: r.name }, add: () => addRecipe(r.name),
}));

/** The entries under each category's heading; k3k clusters are among the clusters. */
const groups = computed(() => CATEGORIES.map(c => ({
  ...c,
  entries: BLOCKS.filter(b => (BLOCK_KIND[b.block].category === "virtual" ? "cluster" : BLOCK_KIND[b.block].category) === c.id)
    .flatMap(b => [blockEntry(b), ...(b.block === "HarvesterVM" || b.block === "Machine" ? recipesOf(b.block) : [])]),
})));

const filter = ref("");
const matching = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return (catalog.value?.profiles ?? []).filter(p => !f || p.name.includes(f) || p.description.toLowerCase().includes(f));
});
/** Profiles with code in the engine: lab hosts only. */
const profiles = computed(() => matching.value.filter(p => p.kind === "custom"));
/** ChartProfiles: charts and objects, on hosts and downstream clusters alike. */
const chartProfiles = computed(() => matching.value.filter(p => p.kind === "chart"));
const fleetProfiles = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return (catalog.value?.fleetProfiles ?? []).filter(p => !f || p.name.includes(f) || p.description.toLowerCase().includes(f));
});
const fleetTitle = (p: { description: string; labels: Record<string, string>; requires: string[] }) =>
  `${p.description}\nlabels: ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}\nneeds: ${p.requires.join(", ") || "—"}`;
const over = ref(false);
const fromBoard = (p: { type: string; from?: number }) => (p.type === "profile" || p.type === "fleet") && p.from !== undefined;
const trash = target(fromBoard, p => {
  if (p.type === "profile" && p.from !== undefined) removeProfile(p.from, p.name);
  if (p.type === "fleet" && p.from !== undefined) removeFleetProfile(p.from, p.name);
}, on => (over.value = on));
const removing = computed(() => !!dragging.value && fromBoard(dragging.value));
</script>

<template>
  <nav class="palette" :class="{ removing, over }" v-on="trash">
    <p v-if="removing" class="trash-hint">Drop here to remove the profile</p>
    <section v-for="g in groups" :key="g.id" class="pgroup" :class="`cat-${g.id}`">
      <h4 :title="g.hint">{{ g.label }}</h4>
      <button
        v-for="e in g.entries" :key="e.key" type="button" class="block" draggable="true" :title="e.hint"
        :class="e.cls"
        @dragstart="start($event, e.payload)" @dragend="end" @click="e.add()"
      >
        <KindIcon :icon="e.icon" />{{ e.label }}
      </button>
    </section>

    <input v-model="filter" class="filter" placeholder="filter profiles…" spellcheck="false" />
    <h4 title="Code in the engine (Kubernetes, Rancher, …): drop on a VM or Machine">Profiles <span class="where">on hosts</span></h4>
    <div
      v-for="p in profiles" :key="p.name" class="pchip" draggable="true" :title="`${p.description}\nprovides: ${p.provides.join(', ') || '—'}\nneeds: ${p.requires.join(', ') || '—'}`"
      @dragstart="start($event, { type: 'profile', name: p.name })" @dragend="end"
    >
      <ProfileIcon :name="p.name" :size="22" class="pi" />
      <span class="pname">{{ p.name }}</span>
      <span class="pdesc">{{ p.description }}</span>
    </div>

    <h4 title="A Helm install with its manifests and objects, by the engine: drop on a host or a downstream cluster">Chart profiles <span class="where">on hosts and clusters</span></h4>
    <div
      v-for="p in chartProfiles" :key="`chart-${p.name}`" class="pchip chart" draggable="true" :title="`${p.description}\nprovides: ${p.provides.join(', ') || '—'}\nneeds: ${p.requires.join(', ') || '—'}`"
      @dragstart="start($event, { type: 'profile', name: p.name })" @dragend="end"
    >
      <ProfileIcon :name="p.name" :size="22" class="pi" />
      <span class="pname">{{ p.name }}</span>
      <span class="pdesc">{{ p.description }}</span>
    </div>

    <h4 title="Labels and annotations for a downstream cluster; Fleet installs what they select: drop on a cluster">Fleet profiles <span class="where">on clusters</span></h4>
    <div
      v-for="p in fleetProfiles" :key="`fleet-${p.name}`" class="pchip fleet" draggable="true" :title="fleetTitle(p)"
      @dragstart="start($event, { type: 'fleet', name: p.name })" @dragend="end"
    >
      <ProfileIcon :name="p.name" :size="22" fleet class="pi" />
      <span class="pname">{{ p.name }}</span>
      <span class="pdesc">{{ p.description }}</span>
    </div>
  </nav>
</template>
