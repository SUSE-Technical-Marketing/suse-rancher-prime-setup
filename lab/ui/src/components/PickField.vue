<script setup lang="ts">
import Field from "./Field.vue";

// Some of a known set of names, as checkboxes, in the set's order. Names given that aren't in it
// stay, shown struck out (the check reports them).
const props = defineProps<{ modelValue?: unknown; options: { value: string; label?: string }[]; label?: string; hint?: string; problem?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | undefined] }>();
const picked = () => (Array.isArray(props.modelValue) ? (props.modelValue as string[]) : []);
const unknown = () => picked().filter(v => !props.options.some(o => o.value === v));
function toggle(v: string) {
  const next = picked().includes(v) ? picked().filter(x => x !== v) : [...picked(), v];
  emit("update:modelValue", next.length > 0 ? next : undefined);
}
</script>

<template>
  <Field :label="label" :hint="hint" :problem="problem">
    <span class="roles">
      <label v-for="o in options" :key="o.value" class="check" :title="o.label"><input type="checkbox" :checked="picked().includes(o.value)" @change="toggle(o.value)" /> {{ o.value }}</label>
      <label v-for="v in unknown()" :key="v" class="check missing" title="not in the catalog"><input type="checkbox" checked @change="toggle(v)" /> {{ v }}</label>
      <span v-if="options.length === 0 && unknown().length === 0" class="field-hint">none in the catalog</span>
    </span>
  </Field>
</template>
<style scoped>
.missing { text-decoration: line-through; opacity: .7; }
</style>
