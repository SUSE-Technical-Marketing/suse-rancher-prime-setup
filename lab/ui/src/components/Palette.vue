<script setup lang="ts">
import ProfileIcon from "./ProfileIcon.vue";
import KindIcon from "./KindIcon.vue";
import { computed, reactive, ref, watch } from "vue";
import { addBlock, addFleetProfile, addProfile, addRecipe, removeFleetProfile, removeProfile } from "../compose";
import { dragging, end, start, target, type Block, type Payload } from "../dnd";
import { CLUSTER_UI } from "../clusters";
import { BLOCK_KIND, CATEGORIES } from "../kinds";
import { catalog, drawer, reportOf, selected, views } from "../store";

// Building blocks, by category, as small tiles, and the profiles, one line each, to drag onto the
// board. A block can also be clicked: it goes on the first Harvester or AWS site. One search box
// filters both. The profiles follow what the drawer has open: only those that go on it, a check on
// the ones it has, suggestions for what its profiles still need, and a click adds one to it. A
// profile dragged back here comes off its host or cluster.
const BLOCKS: { block: Block; label: string; hint: string }[] = [
  { block: "Harvester", label: "Harvester", hint: "a Harvester the lab uses: drop on the board" },
  { block: "HarvesterVM", label: "VM", hint: "a VM: drop on a Harvester" },
  { block: "Machine", label: "Machine", hint: "an existing machine, reached over SSH: drop on the board" },
  { block: "AwsSite", label: "AWS site", hint: "an AWS account and region; the lab gets its own VPC there: drop on the board" },
  // One per downstream cluster type.
  ...Object.values(CLUSTER_UI).map(ui => ({ block: ui.block, label: ui.label, hint: ui.hint })),
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

const filter = ref("");
const q = computed(() => filter.value.trim().toLowerCase());
const hit = (...texts: (string | undefined)[]) => !q.value || texts.some(t => t?.toLowerCase().includes(q.value));

/** The entries under each category's heading; k3k clusters are among the clusters. */
const groups = computed(() => CATEGORIES.map(c => ({
  ...c,
  entries: BLOCKS.filter(b => (BLOCK_KIND[b.block].category === "virtual" ? "cluster" : BLOCK_KIND[b.block].category) === c.id)
    .flatMap(b => [blockEntry(b), ...(b.block === "HarvesterVM" || b.block === "Machine" ? recipesOf(b.block) : [])])
    .filter(e => hit(e.label, e.hint)),
})).filter(g => g.entries.length > 0));

// --- Where profiles go, and what the drawer has open ----------------------------------------
type Where = "all" | "host" | "cluster" | "harvester";
const WHERE: { id: Where; label: string }[] = [
  { id: "all", label: "All" }, { id: "host", label: "Host" }, { id: "cluster", label: "Cluster" }, { id: "harvester", label: "Harvester" },
];
/** The document open in the drawer, when profiles go on it. */
const context = computed(() => {
  if (!drawer.value) return undefined;
  const doc = views.value[selected.value];
  const where: Where | undefined = doc?.kind === "HarvesterVM" || doc?.kind === "Machine" ? "host"
    : doc?.kind === "DownstreamCluster" ? "cluster" : doc?.kind === "Harvester" ? "harvester" : undefined;
  if (!doc || !where) return undefined;
  return {
    index: selected.value, name: String(doc.metadata?.name ?? ""), where,
    profiles: new Set(Object.keys(doc.spec?.profiles ?? {})),
    fleet: new Set(Object.keys(doc.spec?.fleetProfiles ?? {})),
  };
});
/** The user's own choice; it lasts until the drawer opens something else. */
const picked = ref<Where>();
watch(() => context.value?.index, () => (picked.value = undefined));
const where = computed<Where>(() => picked.value ?? context.value?.where ?? "all");
const following = computed(() => !!context.value && where.value === context.value.where);

/** A profile row: an engine Profile, a ChartProfile or a Fleet profile. */
interface Row { key: string; name: string; description: string; title: string; fleet: boolean; kind: "custom" | "chart" | "resource" | "fleet"; provides: string[] }
const goesOn = (targets: string[]) => where.value === "all" || targets.includes(where.value);
// Planned profiles aren't built yet: not offered (a lab using one shows it in its form).
const profileRows = computed<Row[]>(() => (catalog.value?.profiles ?? []).filter(p => p.status !== "planned" && goesOn(p.targets) && hit(p.name, p.description)).map(p => ({
  key: `p-${p.name}`, name: p.name, description: p.description, fleet: false, kind: p.kind,
  provides: [...p.provides, ...p.fallback, p.name],
  title: `${p.description}\nprovides: ${p.provides.join(", ") || "—"}\nneeds: ${p.requires.join(", ") || "—"}\ngoes on: ${p.targets.map(t => ({ host: "a VM or Machine", cluster: "a downstream cluster", harvester: "a Harvester" })[t]).join(", ")}`,
})));
const fleetRows = computed<Row[]>(() => (where.value === "all" || where.value === "cluster" ? catalog.value?.fleetProfiles ?? [] : [])
  .filter(p => hit(p.name, p.description)).map(p => ({
    key: `f-${p.name}`, name: p.name, description: p.description, fleet: true, kind: "fleet" as const, provides: [...p.provides, p.name],
    title: `${p.description}\nlabels: ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}\nneeds: ${p.requires.join(", ") || "—"}\ngoes on: a downstream cluster (Fleet installs it)`,
  })));

/** What the open document's profiles need that nothing on it provides (the engine's say, at the last check), and the profiles that do. */
const suggested = computed(() => {
  const c = context.value;
  if (!c || !following.value) return { needs: [] as string[], rows: [] as Row[] };
  const needs = reportOf(c.index)?.needs ?? [];
  const rows = [...profileRows.value, ...fleetRows.value].filter(r => !isOn(r) && r.provides.some(cap => needs.includes(cap)));
  return { needs, rows };
});

const isOn = (r: Row) => !!context.value && following.value && (r.fleet ? context.value.fleet : context.value.profiles).has(r.name);
const canAdd = (r: Row) => !!context.value && following.value && !isOn(r);
function add(r: Row) {
  const c = context.value;
  if (!c || !canAdd(r)) return;
  if (r.fleet) addFleetProfile(c.index, r.name);
  else addProfile(c.index, r.name);
}

/** The sections, in order; those with nothing to show are left out. */
const sections = computed(() => [
  { id: "custom", label: "Engine", hint: "profiles with code in the engine (Kubernetes, Rancher, …)", rows: profileRows.value.filter(r => r.kind === "custom") },
  { id: "chart", label: "Charts", hint: "a Helm install with its manifests and objects, by the engine", rows: profileRows.value.filter(r => r.kind === "chart") },
  { id: "resource", label: "Resources", hint: "objects for what's installed already (a ClusterRepo, a Fleet GitRepo), by the engine", rows: profileRows.value.filter(r => r.kind === "resource") },
  { id: "fleet", label: "Fleet", hint: "labels and annotations for a downstream cluster; Fleet installs what they select", rows: fleetRows.value },
].filter(s => s.rows.length > 0));

// --- Collapsed sections, remembered ------------------------------------------------------------
const KEY = "lab.palette.collapsed";
const collapsed = reactive<Record<string, boolean>>((() => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } })());
watch(collapsed, v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } });
/** While searching, everything that matches shows. */
const isOpen = (id: string) => !!q.value || !collapsed[id];

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
    <label class="search">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input v-model="filter" class="filter" type="search" placeholder="Search…" title="Search blocks and profiles" aria-label="Search blocks and profiles" spellcheck="false" />
    </label>

    <section v-for="g in groups" :key="g.id" class="pgroup" :class="`cat-${g.id}`">
      <h4 :title="g.hint">{{ g.label }}</h4>
      <div class="tiles">
        <button
          v-for="e in g.entries" :key="e.key" type="button" class="block" draggable="true" :title="e.hint"
          :class="e.cls"
          @dragstart="start($event, e.payload)" @dragend="end" @click="e.add()"
        >
          <KindIcon :icon="e.icon" /><span>{{ e.label }}</span>
        </button>
      </div>
    </section>

    <div class="profiles-head">
      <h4>Profiles</h4>
      <div class="where" role="radiogroup" aria-label="Profiles that go on">
        <button
          v-for="w in WHERE" :key="w.id" type="button" role="radio" :aria-checked="where === w.id"
          @click="picked = w.id"
        >{{ w.label }}</button>
      </div>
      <p v-if="context && following" class="context">
        for <strong>{{ context.name }}</strong>: click to add, or drag
      </p>
      <p v-else-if="context" class="context">
        <button type="button" class="link" @click="picked = undefined">back to {{ context.name }}</button>
      </p>
      <p v-else class="context muted">drag onto the board; open a host or cluster to add with a click</p>
    </div>

    <section v-if="suggested.rows.length" class="psection suggested">
      <h5 :title="`its profiles need: ${suggested.needs.join(', ')}`">Suggested <span class="muted">needs {{ suggested.needs.join(", ") }}</span></h5>
      <button
        v-for="r in suggested.rows" :key="`s-${r.key}`" type="button" class="prow" :class="r.kind" draggable="true" :title="r.title"
        @dragstart="start($event, { type: r.fleet ? 'fleet' : 'profile', name: r.name })" @dragend="end" @click="add(r)"
      >
        <ProfileIcon :name="r.name" :size="18" :fleet="r.fleet" /><span class="pname">{{ r.name }}</span><span class="padd" aria-hidden="true">+</span>
      </button>
    </section>

    <section v-for="s in sections" :key="s.id" class="psection" :class="s.id">
      <h5>
        <button type="button" class="disclose" :aria-expanded="isOpen(s.id)" :title="s.hint" @click="collapsed[s.id] = !collapsed[s.id]">
          <span class="caret">{{ isOpen(s.id) ? "▾" : "▸" }}</span>{{ s.label }} <span class="count">{{ s.rows.length }}</span>
        </button>
      </h5>
      <template v-if="isOpen(s.id)">
        <button
          v-for="r in s.rows" :key="r.key" type="button" class="prow" :class="[r.kind, { on: isOn(r), addable: canAdd(r) }]" draggable="true"
          :title="isOn(r) ? `${r.title}\n(on ${context?.name})` : r.title"
          @dragstart="start($event, { type: r.fleet ? 'fleet' : 'profile', name: r.name })" @dragend="end" @click="add(r)"
        >
          <ProfileIcon :name="r.name" :size="18" :fleet="r.fleet" /><span class="pname">{{ r.name }}</span>
          <span v-if="isOn(r)" class="pon" aria-label="added">✓</span>
          <span v-else-if="canAdd(r)" class="padd" aria-hidden="true">+</span>
        </button>
      </template>
    </section>
    <p v-if="!groups.length && !sections.length" class="muted">Nothing matches “{{ filter }}”.</p>
  </nav>
</template>
