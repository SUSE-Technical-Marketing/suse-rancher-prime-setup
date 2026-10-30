<script setup lang="ts">
import { computed, ref } from "vue";
import type { CatalogProfile } from "../api";
import { catalog } from "../store";
import ProfileIcon from "./ProfileIcon.vue";
import SchemaField from "./SchemaField.vue";

// A host's profiles: which ones, and each one's settings (a form from its JSON Schema).
const props = defineProps<{ modelValue?: Record<string, Record<string, unknown>>; hostKind: "harvester" | "ssh" }>();
const emit = defineEmits<{ set: [name: string, settings: Record<string, unknown> | undefined]; remove: [name: string] }>();

const all = computed(() => catalog.value?.profiles ?? []);
const byName = computed(() => Object.fromEntries(all.value.map(p => [p.name, p])));
const enabled = computed(() => Object.keys(props.modelValue ?? {}));
const available = computed(() => all.value.filter(p => !enabled.value.includes(p.name) && (!p.hostKinds || p.hostKinds.includes(props.hostKind))));
const open = ref<Record<string, boolean>>({});

/** Capabilities the host's profiles provide (their own fallbacks count). */
const provided = computed(() => new Set(enabled.value.flatMap(n => [...(byName.value[n]?.provides ?? []), ...(byName.value[n]?.fallback ?? []), n])));
const providers = (cap: string) => all.value.filter(p => p.provides.includes(cap) || p.fallback.includes(cap)).map(p => p.name);
const missing = (p: CatalogProfile) => p.requires.filter(c => !provided.value.has(c));

function add(e: Event) {
  const name = (e.target as HTMLSelectElement).value;
  (e.target as HTMLSelectElement).value = "";
  if (!name) return;
  emit("set", name, {});
  open.value[name] = true;
}
const settingsOf = (name: string) => props.modelValue?.[name] ?? {};
const hasSettings = (p?: CatalogProfile) => !!p && Object.keys(p.settings.properties ?? {}).length > 0;
</script>

<template>
  <section class="profiles">
    <h3>Profiles</h3>
    <p v-if="enabled.length === 0" class="muted">No profiles: a bare VM or machine (a metal-cluster node, for example).</p>
    <div v-for="name in enabled" :key="name" class="profile">
      <header>
        <button type="button" class="disclose" :aria-expanded="!!open[name]" @click="open[name] = !open[name]">
          <span class="caret">{{ open[name] ? "▾" : "▸" }}</span>
          <ProfileIcon :name="name" :size="22" />
          <strong>{{ name }}</strong>
          <span class="muted">{{ byName[name]?.description ?? "not in the catalog" }}</span>
        </button>
        <button type="button" class="icon" title="Remove profile" @click="emit('remove', name)">×</button>
      </header>
      <div v-if="byName[name]" class="caps">
        <span v-for="c in byName[name].provides" :key="'p' + c" class="chip ok" title="provides">{{ c }}</span>
        <span v-for="c in byName[name].requires" :key="'r' + c" class="chip" :class="provided.has(c) ? 'muted-chip' : 'bad'" :title="provided.has(c) ? 'requires (provided)' : `requires: add ${providers(c).join(' or ')}`">
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
