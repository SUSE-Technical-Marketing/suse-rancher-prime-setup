<script setup lang="ts">
import { ref, watch } from "vue";
import { check, docOf, drawer, parseError, selected, setText, text } from "../store";

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
        <span v-if="check?.diagnostics.length" class="badge" :class="check.ok ? 'warn' : 'bad'">{{ check.diagnostics.length }}</span>
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
      <p v-if="check?.missingSecrets.length" class="warn-text">Not in your personal config yet: {{ check.missingSecrets.join(", ") }}.</p>
      <p v-if="check && check.diagnostics.length === 0" class="muted">No problems.</p>
      <ul class="problems">
        <li v-for="(d, i) in check?.diagnostics ?? []" :key="i" :class="d.level">
          <button type="button" class="link" @click="open(d.path)">{{ d.path || d.source }}</button>
          <span>{{ d.message }}</span>
        </li>
      </ul>
    </div>
  </aside>
</template>
