<script setup lang="ts">
import Field from "./Field.vue";

// An address range, [first, last].
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; required?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | undefined] }>();
const pair = () => (Array.isArray(props.modelValue) ? props.modelValue : ["", ""]) as string[];
function update(i: number, e: Event) {
  const next = [...pair()];
  next[i] = (e.target as HTMLInputElement).value.trim();
  emit("update:modelValue", next[0] || next[1] ? next : undefined);
}
</script>

<template>
  <Field :label="label" :hint="hint" :required="required">
    <span class="range">
      <input :value="pair()[0]" placeholder="first" spellcheck="false" @change="update(0, $event)" />
      <span>–</span>
      <input :value="pair()[1]" placeholder="last" spellcheck="false" @change="update(1, $event)" />
    </span>
  </Field>
</template>
