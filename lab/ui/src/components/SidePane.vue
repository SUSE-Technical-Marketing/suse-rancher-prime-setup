<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { catalog, check, docOf, drawer, parseError, selected, setText, text } from "../store";

// The lab as YAML (editable: applied when it parses), `lab plan`, and the problems.
const tab = ref<"yaml" | "plan" | "problems">("yaml");
const draft = ref(text.value);
let editing = false;
watch(text, t => { if (!editing) draft.value = t; });

let timer: ReturnType<typeof setTimeout> | undefined;
function typed() {
  editing = true;
  clearTimeout(timer);
  timer = setTimeout(() => { setText(draft.value); editing = false; }, 500);
}
const personalProblems = computed(() => catalog.value?.personal.problems ?? []);
/** The lab's own problems: the personal config's are listed on their own, above them. */
const diagnostics = computed(() => (check.value?.diagnostics ?? []).filter(d => !personalProblems.value.length || d.source !== catalog.value?.personal.source));
const count = computed(() => diagnostics.value.length + personalProblems.value.length);
function open(path: string) {
  const { index } = docOf(path);
  if (index < 0) return;
  selected.value = index;
  drawer.value = true;
}
</script>

<template>
  <aside class="side">
    <div class="tabs" role="tablist">
      <button role="tab" :aria-selected="tab === 'yaml'" @click="tab = 'yaml'">YAML</button>
      <button role="tab" :aria-selected="tab === 'plan'" @click="tab = 'plan'">Plan</button>
      <button role="tab" :aria-selected="tab === 'problems'" @click="tab = 'problems'">
        Problems
        <span v-if="count" class="badge" :class="check?.ok && !personalProblems.length ? 'warn' : 'bad'">{{ count }}</span>
      </button>
    </div>
    <div v-if="tab === 'yaml'" class="pane">
      <p v-if="parseError" class="warn-text">Not applied: {{ parseError }}</p>
      <textarea v-model="draft" class="mono yaml" spellcheck="false" @input="typed" />
    </div>
    <div v-else-if="tab === 'plan'" class="pane">
      <pre v-if="check?.plan" class="mono plan">{{ check.plan }}</pre>
      <p v-else class="muted">The plan appears once the lab has no errors.</p>
    </div>
    <div v-else class="pane">
      <div v-if="personalProblems.length" class="personal">
        <p class="warn-text">Your personal config doesn't load ({{ catalog?.personal.source }}): the composer uses the built-in catalog without it, and no secrets, Harvesters or AWS sites from it.</p>
        <ul class="problems">
          <li v-for="(p, i) in personalProblems" :key="i" class="error"><span>{{ p }}</span></li>
        </ul>
      </div>
      <p v-if="check?.missingSecrets.length" class="warn-text">Not in your personal config yet: {{ check.missingSecrets.join(", ") }}.</p>
      <p v-if="check && count === 0" class="muted">No problems.</p>
      <ul class="problems">
        <li v-for="(d, i) in diagnostics" :key="i" :class="d.level">
          <button type="button" class="link" @click="open(d.path)">{{ d.path || d.source }}</button>
          <span>{{ d.message }}</span>
        </li>
      </ul>
    </div>
  </aside>
</template>
