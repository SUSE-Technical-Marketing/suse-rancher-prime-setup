<script setup lang="ts">
import { ref, watch } from "vue";
import { parse, stringify } from "yaml";
import Field from "./Field.vue";

// Anything without a form of its own (chart values, passthrough config), as YAML.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; rows?: number }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const textOf = (v: unknown) => (v === undefined ? "" : stringify(v, { lineWidth: 0 }).trimEnd());
const text = ref(textOf(props.modelValue));
const error = ref("");
watch(() => props.modelValue, v => {
  // Don't overwrite what's being typed with the same value re-serialized.
  try { if (JSON.stringify(parse(text.value)) === JSON.stringify(v)) return; } catch { /* replace */ }
  text.value = textOf(v);
  error.value = "";
});

function commit() {
  try {
    const value = text.value.trim() === "" ? undefined : parse(text.value);
    error.value = "";
    emit("update:modelValue", value === null ? undefined : value);
  } catch (e) {
    error.value = (e as Error).message.split("\n")[0];
  }
}
</script>

<template>
  <Field :label="label" :hint="error || hint" wide>
    <textarea v-model="text" class="mono" :class="{ invalid: error }" :rows="rows ?? 4" spellcheck="false" @change="commit" />
  </Field>
</template>
