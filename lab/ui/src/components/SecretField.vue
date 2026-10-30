<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { isTemplate, secretPath, secretTemplate } from "../secrets";
import { catalog } from "../store";
import Field from "./Field.vue";

// A secret: a template over the personal config's secrets (names offered; values never reach the
// UI) or a field in one (`cloudflare.token`), a template with more in it ("Bearer {{ secrets.token }}"), or a value written in the lab file,
// which `validate` warns about.
// `fields`: a map secret with at least these fields (AWS keys), instead of a `shape`.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; required?: boolean; shape?: "string" | "credentials"; fields?: string[]; allowPlain?: boolean; problem?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

/** The secret's path, dotted: `cloudflare.token`. */
const name = computed(() => secretPath(props.modelValue)?.join("."));
/** "secret" picked, no secret chosen yet; or a name being typed that isn't offered. */
const picking = ref(false);
const typing = ref(false);
const mode = computed(() => (props.modelValue === undefined ? (picking.value ? "secret" : "none") : name.value !== undefined ? "secret" : isTemplate(props.modelValue) ? "template" : "plain"));
const names = computed(() => (catalog.value?.personal.secrets ?? [])
  .filter(s => (props.fields ? props.fields.every(f => s.fields?.includes(f)) : !props.shape || s.shape === props.shape))
  .map(s => s.name));
const known = (n: string) => (catalog.value?.personal.secrets ?? []).find(s => s.name === n);
const other = ref<HTMLInputElement>();
/** The "other name…" option: no secret's path starts with a space. */
const OTHER = " other";
const missing = computed(() => name.value !== undefined && !known(name.value));
const shownHint = computed(() => {
  if (missing.value) return `not in your personal config (${catalog.value?.personal.source})`;
  if (mode.value === "plain") return "written in the lab file: use a secret before sharing it";
  if (mode.value === "template") return "a template over secrets, e.g. Bearer {{ secrets.token }}";
  return props.hint;
});

function setMode(m: string) {
  picking.value = m === "secret";
  typing.value = false;
  if (m === "none") emit("update:modelValue", undefined);
  else if (m === "secret") emit("update:modelValue", undefined);
  else if (m === "template") emit("update:modelValue", name.value ? template(name.value) : "{{ secrets. }}");
  else emit("update:modelValue", undefined);
}
function choose(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  if (v === OTHER) {
    typing.value = true;
    void nextTick(() => other.value?.focus());
    return;
  }
  emit("update:modelValue", v ? template(v) : undefined);
}
function setName(e: Event) {
  const v = (e.target as HTMLInputElement).value.trim();
  emit("update:modelValue", v ? template(v) : undefined);
  if (!v) typing.value = false;
}
/** A known secret or field by its path; anything else typed is read as a path. */
const template = (n: string) => secretTemplate(known(n)?.path ?? n.split("."));
const setText = (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value || undefined);
</script>

<template>
  <Field :label="label" :required="required" :hint="shownHint" :problem="problem">
    <span class="secret">
      <select :value="mode" @change="setMode(($event.target as HTMLSelectElement).value)">
        <option value="none">{{ required ? "—" : "none" }}</option>
        <option value="secret">secret</option>
        <option value="template">template</option>
        <option v-if="allowPlain !== false" value="plain">value</option>
      </select>
      <template v-if="mode === 'secret'">
        <input v-if="typing" ref="other" :value="name" placeholder="secret, or secret.field" spellcheck="false" :class="{ warn: missing }" @change="setName" />
        <select v-else :value="name ?? ''" :class="{ warn: missing }" @change="choose">
          <option value="" disabled>choose…</option>
          <option v-if="name && !names.includes(name)" :value="name">{{ name }}</option>
          <option v-for="n in names" :key="n" :value="n">{{ n }}</option>
          <option :value="OTHER">other name…</option>
        </select>
      </template>
      <input v-else-if="mode === 'template'" class="mono" :value="modelValue as string" spellcheck="false" @change="setText" />
      <input v-else-if="mode === 'plain'" type="password" :value="modelValue as string" autocomplete="off" @change="setText" />
    </span>
  </Field>
</template>
