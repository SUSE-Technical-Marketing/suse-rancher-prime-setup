<script setup lang="ts">
import Field from "./Field.vue";

// A select; the empty option ("default ..." or "none") gives `undefined`.
defineProps<{
  modelValue?: unknown; label?: string; hint?: string; required?: boolean;
  options: (string | { value: string; label: string })[];
  empty?: string; problem?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string | undefined] }>();
</script>

<template>
  <Field :label="label" :hint="hint" :required="required" :problem="problem">
    <select :value="modelValue ?? ''" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value || undefined)">
      <option v-if="empty !== undefined || modelValue === undefined" value="">{{ empty ?? "—" }}</option>
      <option
        v-if="typeof modelValue === 'string' && modelValue && !options.some(o => (typeof o === 'string' ? o : o.value) === modelValue)"
        :value="modelValue"
      >{{ modelValue }} (unknown)</option>
      <option v-for="o in options" :key="typeof o === 'string' ? o : o.value" :value="typeof o === 'string' ? o : o.value">
        {{ typeof o === "string" ? o : o.label }}
      </option>
    </select>
  </Field>
</template>
