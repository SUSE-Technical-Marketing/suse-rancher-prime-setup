<script setup lang="ts">
import { computed } from "vue";
import { isTemplate, secretTemplate, wholeSecret } from "../secrets";
import { catalog } from "../store";
import Field from "./Field.vue";

// A secret: a template over the personal config's secrets (names offered; values never reach the
// UI), a template with more in it ("Bearer {{ secrets.token }}"), or a value written in the lab file,
// which `validate` warns about.
// `fields`: a map secret with at least these fields (AWS keys), instead of a `shape`.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; required?: boolean; shape?: "string" | "credentials"; fields?: string[]; allowPlain?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const name = computed(() => wholeSecret(props.modelValue));
const mode = computed(() => (props.modelValue === undefined ? "none" : name.value !== undefined ? "secret" : isTemplate(props.modelValue) ? "template" : "plain"));
const names = computed(() => (catalog.value?.personal.secrets ?? [])
  .filter(s => (props.fields ? props.fields.every(f => s.fields?.includes(f)) : !props.shape || s.shape === props.shape))
  .map(s => s.name));
const listId = `secrets-${Math.random().toString(36).slice(2)}`;
const missing = computed(() => name.value !== undefined && !(catalog.value?.personal.secrets ?? []).some(s => s.name === name.value));
const shownHint = computed(() => {
  if (missing.value) return `not in your personal config (${catalog.value?.personal.source})`;
  if (mode.value === "plain") return "written in the lab file: use a secret before sharing it";
  if (mode.value === "template") return "a template over secrets, e.g. Bearer {{ secrets.token }}";
  return props.hint;
});

function setMode(m: string) {
  if (m === "none") emit("update:modelValue", undefined);
  else if (m === "secret") emit("update:modelValue", names.value[0] ? secretTemplate(names.value[0]) : undefined);
  else if (m === "template") emit("update:modelValue", name.value ? secretTemplate(name.value) : "{{ secrets. }}");
  else emit("update:modelValue", undefined);
}
function setName(e: Event) {
  const v = (e.target as HTMLInputElement).value.trim();
  emit("update:modelValue", v ? secretTemplate(v) : undefined);
}
const setText = (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value || undefined);
</script>

<template>
  <Field :label="label" :required="required" :hint="shownHint">
    <span class="secret">
      <select :value="mode" @change="setMode(($event.target as HTMLSelectElement).value)">
        <option value="none">{{ required ? "—" : "none" }}</option>
        <option value="secret">secret</option>
        <option value="template">template</option>
        <option v-if="allowPlain !== false" value="plain">value</option>
      </select>
      <template v-if="mode === 'secret'">
        <input :list="listId" :value="name" placeholder="secret name" spellcheck="false" :class="{ warn: missing }" @change="setName" />
        <datalist :id="listId"><option v-for="n in names" :key="n" :value="n" /></datalist>
      </template>
      <input v-else-if="mode === 'template'" class="mono" :value="modelValue as string" spellcheck="false" @change="setText" />
      <input v-else-if="mode === 'plain'" type="password" :value="modelValue as string" autocomplete="off" @change="setText" />
    </span>
  </Field>
</template>
