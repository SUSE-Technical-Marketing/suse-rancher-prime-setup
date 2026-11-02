<script setup lang="ts">
import { computed, ref } from "vue";
import type { CatalogProfile } from "../api";
import { clustersProviding, profileDefaults } from "../compose";
import { catalog, reportOf } from "../store";
import ProfileIcon from "./ProfileIcon.vue";
import SchemaField from "./SchemaField.vue";

// A host's, downstream cluster's or Harvester's profiles: which ones, and each one's settings (a form
// from its JSON Schema). A cluster or a Harvester (`hci`) takes the profiles that target it, and is
// itself `kubernetes`. A setting naming a cluster (the agent's observer) offers the ones that qualify.
// What they need and don't have is the engine's say (the last check), not worked out here.
const props = defineProps<{ index: number; modelValue?: Record<string, Record<string, unknown>>; target: "harvester" | "ssh" | "cluster" | "hci" }>();
const emit = defineEmits<{ set: [name: string, settings: Record<string, unknown> | undefined]; remove: [name: string] }>();

const all = computed(() => catalog.value?.profiles ?? []);
const byName = computed(() => Object.fromEntries(all.value.map(p => [p.name, p])));
const enabled = computed(() => Object.keys(props.modelValue ?? {}));
const fits = (p: CatalogProfile) => props.target === "cluster" ? p.targets.includes("cluster")
  : props.target === "hci" ? p.targets.includes("harvester")
  : p.targets.includes("host") && (!p.hostKinds || p.hostKinds.includes(props.target));
/** A setting naming a downstream cluster: the lab's clusters that qualify. */
const clusterOptions = (p: CatalogProfile, key: string) => {
  const ref = p.clusterRefs.find(r => r.field === key);
  return ref ? clustersProviding(ref.provides) : undefined;
};
const available = computed(() => all.value.filter(p => p.status !== "planned" && !enabled.value.includes(p.name) && fits(p)));
const open = ref<Record<string, boolean>>({});

/** What its profiles need that nothing on it provides, as the engine judged it at the last check. */
const needs = computed(() => new Set(reportOf(props.index)?.needs ?? []));
const providers = (cap: string) => all.value.filter(p => p.provides.includes(cap) || p.fallback.includes(cap)).map(p => p.name);
const missing = (p: CatalogProfile) => p.requires.filter(c => needs.value.has(c));

function add(e: Event) {
  const name = (e.target as HTMLSelectElement).value;
  (e.target as HTMLSelectElement).value = "";
  if (!name) return;
  // What a drop on the board gives it too: an observer when only one cluster qualifies, logins from the personal config.
  emit("set", name, profileDefaults(name));
  open.value[name] = true;
}
const settingsOf = (name: string) => props.modelValue?.[name] ?? {};
const hasSettings = (p?: CatalogProfile) => !!p && Object.keys(p.settings.properties ?? {}).length > 0;
</script>

<template>
  <section class="profiles">
    <h3>Profiles</h3>
    <p v-if="enabled.length === 0" class="muted">{{ target === "cluster" ? "No profiles: the engine installs nothing on the cluster itself."
      : target === "hci" ? "No profiles: the engine only installs its DHCP add-on on the Harvester (when a network has lab DHCP). Add harvester-dns-controller for DNS records on your router."
      : "No profiles: a bare VM or machine (a metal-cluster node, for example)." }}</p>
    <div v-for="name in enabled" :key="name" class="profile">
      <header>
        <button type="button" class="disclose" :aria-expanded="!!open[name]" @click="open[name] = !open[name]">
          <span class="caret">{{ open[name] ? "▾" : "▸" }}</span>
          <ProfileIcon :name="name" :size="22" />
          <strong>{{ name }}</strong>
          <span class="muted">{{ byName[name]?.description ?? "not in the catalog" }}</span>
          <span v-if="byName[name]?.status === 'planned'" class="chip bad" title="the engine doesn't build it yet: lab up refuses this lab">planned</span>
        </button>
        <button type="button" class="icon" title="Remove profile" @click="emit('remove', name)">×</button>
      </header>
      <div v-if="byName[name]" class="caps">
        <span v-for="c in byName[name].provides" :key="'p' + c" class="chip ok" title="provides">{{ c }}</span>
        <span v-for="c in byName[name].requires" :key="'r' + c" class="chip" :class="needs.has(c) ? 'bad' : 'muted-chip'" :title="needs.has(c) ? `requires: add ${providers(c).join(' or ')}` : 'requires (provided)'">
          needs {{ c }}
        </span>
      </div>
      <p v-if="byName[name] && missing(byName[name]).length" class="warn-text">
        Needs {{ missing(byName[name]).map(c => `${c} (${providers(c).join(" or ")})`).join(", ") }}.
      </p>
      <div v-if="open[name] && hasSettings(byName[name])" class="grid">
        <SchemaField
          v-for="(schema, key) in byName[name].settings.properties"
          :key="key"
          :schema="schema"
          :options="clusterOptions(byName[name], String(key))"
          :label="String(key)"
          :required="byName[name].settings.required?.includes(String(key))"
          :model-value="settingsOf(name)[key]"
          @update:model-value="v => emit('set', name, (() => { const s = { ...settingsOf(name), [key]: v }; if (v === undefined) delete s[key]; return s; })())"
        />
      </div>
      <p v-else-if="open[name]" class="muted">No settings.</p>
    </div>
    <select class="add" @change="add">
      <option value="">+ add a profile…</option>
      <option v-for="p in available" :key="p.name" :value="p.name">{{ p.name }} — {{ p.description }}</option>
    </select>
  </section>
</template>
