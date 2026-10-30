<script setup lang="ts">
import { computed } from "vue";
import { listProblem, type AddressFormat } from "../net";
import Field from "./Field.vue";

// A list of strings, written comma-separated; `format`: each an IP address or a CIDR.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; placeholder?: string; format?: AddressFormat; pattern?: string; problem?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | undefined] }>();

const problemShown = computed(() => listProblem(props.modelValue, props.format, props.pattern) || props.problem);
const shown = () => (Array.isArray(props.modelValue) ? props.modelValue.join(", ") : "");
function update(e: Event) {
  const items = (e.target as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean);
  emit("update:modelValue", items.length > 0 ? items : undefined);
}
</script>

<template>
  <Field :label="label" :hint="hint" :problem="problemShown">
    <input type="text" :value="shown()" :placeholder="placeholder ?? 'a, b, c'" spellcheck="false" @change="update" />
  </Field>
</template>
