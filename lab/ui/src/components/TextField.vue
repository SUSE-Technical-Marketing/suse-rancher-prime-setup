<script setup lang="ts">
import { computed } from "vue";
import { addressProblem, patternProblem, type AddressFormat } from "../net";
import Field from "./Field.vue";

// A text or number input. Clearing it gives `undefined`, which removes the key from the file.
// `format`: an IP address or a CIDR, checked as you type; `problem`: the engine's, for this field.
const props = defineProps<{
  modelValue?: unknown; label?: string; hint?: string; placeholder?: string;
  number?: boolean; required?: boolean; password?: boolean; list?: string;
  format?: AddressFormat; pattern?: string; problem?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string | number | undefined] }>();

const shown = computed(() => (props.format && addressProblem(props.modelValue, props.format)) || patternProblem(props.modelValue, props.pattern) || props.problem);

function update(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  if (raw.trim() === "") return emit("update:modelValue", undefined);
  emit("update:modelValue", props.number && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw);
}
</script>

<template>
  <Field :label="label" :hint="hint" :required="required" :problem="shown">
    <input
      :type="password ? 'password' : 'text'"
      :inputmode="number ? 'numeric' : undefined"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :class="{ bad: !!shown }"
      :list="list"
      spellcheck="false"
      autocomplete="off"
      @change="update"
    />
  </Field>
</template>
