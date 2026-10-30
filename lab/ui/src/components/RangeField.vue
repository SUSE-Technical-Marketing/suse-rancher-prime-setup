<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { rangeProblem } from "../net";
import Field from "./Field.vue";

// An address range, [first, last]: checked as you type; `problem`: the engine's, for this field.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; required?: boolean; problem?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | undefined] }>();
const shown = computed(() => rangeProblem(props.modelValue) ?? props.problem);
/** What the inputs hold, so a second edit before the lab updates keeps the first. */
const local = ref<string[]>([]);
watch(() => props.modelValue, v => { local.value = Array.isArray(v) ? v.map(String) : ["", ""]; }, { immediate: true });
const pair = () => local.value;
function update(i: number, e: Event) {
  const next = [...pair()];
  next[i] = (e.target as HTMLInputElement).value.trim();
  local.value = next;
  emit("update:modelValue", next[0] || next[1] ? next : undefined);
}
</script>

<template>
  <Field :label="label" :hint="hint" :required="required" :problem="shown">
    <span class="range">
      <input :value="pair()[0]" placeholder="first" spellcheck="false" @change="update(0, $event)" />
      <span>–</span>
      <input :value="pair()[1]" placeholder="last" spellcheck="false" @change="update(1, $event)" />
    </span>
  </Field>
</template>
