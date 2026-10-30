<script setup lang="ts">
import Field from "./Field.vue";

// A text or number input. Clearing it gives `undefined`, which removes the key from the file.
const props = defineProps<{
  modelValue?: unknown; label?: string; hint?: string; placeholder?: string;
  number?: boolean; required?: boolean; password?: boolean; list?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string | number | undefined] }>();

function update(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  if (raw.trim() === "") return emit("update:modelValue", undefined);
  emit("update:modelValue", props.number && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw);
}
</script>

<template>
  <Field :label="label" :hint="hint" :required="required">
    <input
      :type="password ? 'password' : 'text'"
      :inputmode="number ? 'numeric' : undefined"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :list="list"
      spellcheck="false"
      autocomplete="off"
      @change="update"
    />
  </Field>
</template>
