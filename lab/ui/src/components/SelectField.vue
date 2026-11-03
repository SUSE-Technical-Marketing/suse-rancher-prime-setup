<script setup lang="ts">
import { computed } from "vue";
import Field from "./Field.vue";

// A select; the empty option ("none", "the Harvester's default") gives `undefined`. With
// `defaultValue` (one of the options) there's no empty option: that option says "(default)", shows
// while the field is unset, and choosing it leaves the field unset again.
const props = defineProps<{
  modelValue?: unknown; label?: string; hint?: string; required?: boolean;
  options: (string | { value: string; label: string })[];
  empty?: string; defaultValue?: string; problem?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string | undefined] }>();
const valueOf = (o: string | { value: string }) => (typeof o === "string" ? o : o.value);
const labelOf = (o: string | { label: string }) => (typeof o === "string" ? o : o.label);
/** The default, when it's one of the options. */
const def = computed(() => (props.defaultValue !== undefined && props.options.some(o => valueOf(o) === props.defaultValue) ? props.defaultValue : undefined));
const shown = computed(() => (props.modelValue === undefined || props.modelValue === "" ? def.value ?? "" : props.modelValue));
function pick(value: string) {
  emit("update:modelValue", value === "" || value === def.value ? undefined : value);
}
</script>

<template>
  <Field :label="label" :hint="hint" :required="required" :problem="problem">
    <select :value="shown" @change="pick(($event.target as HTMLSelectElement).value)">
      <option v-if="def === undefined && (empty !== undefined || modelValue === undefined)" value="">{{ empty ?? "—" }}</option>
      <option
        v-if="typeof modelValue === 'string' && modelValue && !options.some(o => valueOf(o) === modelValue)"
        :value="modelValue"
      >{{ modelValue }} (unknown)</option>
      <option v-for="o in options" :key="valueOf(o)" :value="valueOf(o)">
        {{ labelOf(o) }}{{ valueOf(o) === def ? " (default)" : "" }}
      </option>
    </select>
  </Field>
</template>
