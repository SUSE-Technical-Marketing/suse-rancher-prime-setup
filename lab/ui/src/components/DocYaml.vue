<script setup lang="ts">
import { ref, watch } from "vue";
import { docText, setDocText } from "../store";

// One document's YAML, editable: applied when it parses as one document.
const props = defineProps<{ index: number }>();
const draft = ref(docText(props.index));
const problem = ref("");
let editing = false;
watch(() => docText(props.index), t => { if (!editing) draft.value = t; });

let timer: ReturnType<typeof setTimeout> | undefined;
function typed() {
  editing = true;
  clearTimeout(timer);
  timer = setTimeout(() => { problem.value = setDocText(props.index, draft.value) ?? ""; editing = false; }, 500);
}
</script>

<template>
  <div class="docyaml">
    <p v-if="problem" class="warn-text">Not applied: {{ problem }}</p>
    <textarea v-model="draft" class="mono yaml" spellcheck="false" @input="typed" />
  </div>
</template>
