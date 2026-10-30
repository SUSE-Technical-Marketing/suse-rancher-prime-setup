<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "./api";
import AwsSiteEditor from "./components/AwsSiteEditor.vue";
import DocYaml from "./components/DocYaml.vue";
import DownstreamEditor from "./components/DownstreamEditor.vue";
import GenericEditor from "./components/GenericEditor.vue";
import HarvesterEditor from "./components/HarvesterEditor.vue";
import HostEditor from "./components/HostEditor.vue";
import LabEditor from "./components/LabEditor.vue";
import Palette from "./components/Palette.vue";
import SidePane from "./components/SidePane.vue";
import GraphCanvas from "./components/GraphCanvas.vue";
import { catalog, check, dirty, docOf, drawer, drawerTab, file, load, newLabText, selected, sideTab, text, views } from "./store";

const labs = ref<string[]>([]);
const error = ref("");
const checking = ref(false);
const saving = ref(false);
function edit(index: number) {
  selected.value = index;
  drawer.value = true;
}

const current = computed(() => views.value[selected.value]);
/** The open document's own problems, over its form. */
const currentProblems = computed(() => (check.value?.diagnostics ?? []).filter(d => docOf(d.path).index === selected.value));
/** The status in the header opens the problems. */
function showProblems() {
  drawer.value = false;
  sideTab.value = "problems";
}
window.addEventListener("keydown", e => { if (e.key === "Escape" && drawer.value) drawer.value = false; });
const editor = computed(() => {
  switch (current.value?.kind) {
    case "Lab": return LabEditor;
    case "Harvester": return HarvesterEditor;
    case "AwsSite": return AwsSiteEditor;
    case "HarvesterVM":
    case "Machine": return HostEditor;
    case "DownstreamCluster": return DownstreamEditor;
    default: return GenericEditor;
  }
});
const labName = computed(() => views.value.find(v => v.kind === "Lab")?.metadata?.name ?? "");
const saveAs = computed(() => file.value || (labName.value ? `${labName.value}.yaml` : ""));
const status = computed(() => {
  if (checking.value && !check.value) return { cls: "", text: "checking…" };
  const c = check.value;
  if (!c) return { cls: "", text: "" };
  const errors = c.diagnostics.filter(d => d.level === "error").length;
  const warnings = c.diagnostics.length - errors;
  if (errors) return { cls: "bad", text: `${errors} error${errors > 1 ? "s" : ""}` };
  if (warnings) return { cls: "warn", text: `valid, ${warnings} warning${warnings > 1 ? "s" : ""}` };
  return { cls: "ok", text: c.missingSecrets.length ? `valid, ${c.missingSecrets.length} secret(s) not set` : "valid" };
});

async function refreshLabs() {
  labs.value = (await api.labs()).map(l => l.file);
}

onMounted(async () => {
  try {
    catalog.value = await api.catalog();
    await refreshLabs();
    load(newLabText("my-lab"), "");
    dirty.value = false;
  } catch (e) {
    error.value = (e as Error).message;
  }
});

// Check with the engine a moment after each change.
let timer: ReturnType<typeof setTimeout> | undefined;
let run = 0;
watch(text, t => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const mine = ++run;
    checking.value = true;
    try {
      const result = await api.check(t, saveAs.value);
      if (mine === run) check.value = result;
    } catch (e) {
      if (mine === run) error.value = (e as Error).message;
    } finally {
      if (mine === run) checking.value = false;
    }
  }, 400);
}, { immediate: true });

const leave = () => !dirty.value || confirm("Discard the unsaved changes?");

async function open(e: Event) {
  const select = e.target as HTMLSelectElement;
  const name = select.value;
  select.value = "";
  if (!name || !leave()) return;
  try {
    const { text: source } = await api.lab(name);
    const problem = load(source, name);
    drawer.value = false;
    if (problem) error.value = `${name}: ${problem}`;
    else error.value = "";
  } catch (err) {
    error.value = (err as Error).message;
  }
}

function create() {
  if (!leave()) return;
  const name = prompt("Lab name (lowercase letters, digits and -):", "my-lab")?.trim();
  if (!name) return;
  load(newLabText(name), "");
  dirty.value = true;
  drawer.value = false;
}

async function save() {
  let target = saveAs.value;
  if (!file.value) {
    target = prompt("Save as (in lab/labs):", target)?.trim() ?? "";
    if (!target) return;
    if (!target.endsWith(".yaml")) target += ".yaml";
  }
  saving.value = true;
  try {
    try {
      await api.save(target, text.value, !!file.value && file.value === target);
    } catch (e) {
      if ((e as { status?: number }).status !== 409 || !confirm(`${target} exists. Overwrite it?`)) throw e;
      await api.save(target, text.value, true);
    }
    file.value = target;
    dirty.value = false;
    error.value = "";
    await refreshLabs();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

window.addEventListener("beforeunload", e => { if (dirty.value) e.preventDefault(); });
</script>

<template>
  <div class="app">
    <header class="top">
      <h1><span class="brand">SUSE</span> Lab composer</h1>
      <div class="file">
        <strong>{{ file || "new lab" }}</strong><span v-if="dirty" class="dot" title="unsaved changes">●</span>
      </div>
      <select class="open" @change="open">
        <option value="">Open…</option>
        <option v-for="l in labs" :key="l" :value="l">{{ l }}</option>
      </select>
      <button type="button" @click="create">New</button>
      <button type="button" class="primary" :disabled="saving || (!dirty && !!file)" @click="save">{{ saving ? "Saving…" : "Save" }}</button>
      <button v-if="status.text" type="button" class="status" :class="status.cls" title="Show the problems" @click="showProblems">{{ status.text }}</button>
    </header>
    <p v-if="error" class="banner">{{ error }} <button type="button" class="icon" @click="error = ''">×</button></p>
    <main v-if="catalog" class="layout">
      <Palette />
      <section class="center">
        <GraphCanvas @select="edit" />
      </section>
      <div class="right">
        <SidePane />
        <aside v-if="drawer && current" class="drawer" aria-label="Edit">
          <div class="drawer-bar">
            <div class="tabs" role="tablist">
              <button role="tab" :aria-selected="drawerTab === 'form'" @click="drawerTab = 'form'">Form</button>
              <button role="tab" :aria-selected="drawerTab === 'yaml'" @click="drawerTab = 'yaml'">YAML</button>
            </div>
            <span class="muted drawer-title">{{ current.kind }} {{ current.metadata?.name }}</span>
            <button type="button" class="close" title="Back to the lab's YAML, plan and problems (Esc)" @click="drawer = false">Close ×</button>
          </div>
          <ul v-if="currentProblems.length" class="problems doc-problems">
            <li v-for="(d, i) in currentProblems" :key="i" :class="d.level">
              <span v-if="docOf(d.path).field" class="mono">{{ docOf(d.path).field }}</span>
              <span>{{ d.message }}</span>
            </li>
          </ul>
          <component :is="editor" v-if="drawerTab === 'form'" :key="selected" :index="selected" />
          <DocYaml v-else :key="`yaml-${selected}`" :index="selected" />
        </aside>
      </div>
    </main>
    <p v-else-if="!error" class="muted loading">Loading the catalog…</p>
  </div>
</template>
