<script setup lang="ts">
import Field from "./Field.vue";

// A list of strings, written comma-separated.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; placeholder?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | undefined] }>();

const shown = () => (Array.isArray(props.modelValue) ? props.modelValue.join(", ") : "");
function update(e: Event) {
  const items = (e.target as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean);
  emit("update:modelValue", items.length > 0 ? items : undefined);
}
</script>

<template>
  <Field :label="label" :hint="hint">
    <input type="text" :value="shown()" :placeholder="placeholder ?? 'a, b, c'" spellcheck="false" @change="update" />
  </Field>
</template>
