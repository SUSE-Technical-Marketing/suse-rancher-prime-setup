<script setup lang="ts">
import { computed, inject } from "vue";
import type { SettingSchema } from "../api";
import { FORM_CONTEXT, fill, visible, type FormContext, type Option } from "../form";
import { catalog, views } from "../store";
import AwsCredentialsField from "./AwsCredentialsField.vue";
import CredentialsField from "./CredentialsField.vue";
import KeyValue from "./KeyValue.vue";
import ListField from "./ListField.vue";
import PickField from "./PickField.vue";
import RangeField from "./RangeField.vue";
import RolesField from "./RolesField.vue";
import SecretField from "./SecretField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

// One setting or document field, its control chosen from its schema. Objects with properties nest;
// what has no simple control (anyOf, chart values, lists of objects) is edited as YAML. A document's
// schema says how to show a field (`form`: label, hint, placeholder, the lab's list to choose from),
// filled in from what its editor provides (FORM_CONTEXT).
// `options`: the values it can take, when the caller knows them (the clusters an `observer` can name).
// `vars`: more values for the form's templates (a card's `item`).
const props = defineProps<{ schema: SettingSchema; modelValue?: unknown; label: string; required?: boolean; options?: Option[]; problem?: string; vars?: Record<string, unknown> }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const JSON_TYPES = ["string", "integer", "number", "boolean", "object", "array"];
const context = inject(FORM_CONTEXT, (): FormContext => ({ options: {}, vars: {} }));
const s = computed(() => props.schema);
const f = computed(() => s.value.form ?? {});
const vars = computed(() => ({ ...context().vars, ...props.vars }));
const label = computed(() => f.value.label ?? props.label);
const choices = computed(() => props.options ?? (f.value.options ? context().options[f.value.options] ?? [] : undefined));
const hint = computed(() => (choices.value?.length === 0 ? "none in the lab yet" : fill(f.value.hint ?? s.value.description, vars.value)));
const placeholder = computed(() => fill(f.value.placeholder, vars.value) ?? (s.value.default !== undefined && typeof s.value.default !== "object" ? `default ${s.value.default}` : undefined));
/** The schema's default as a select's value (`dynamic`, `true`): that option says "(default)". */
const defaultString = computed(() => (s.value.default !== undefined && typeof s.value.default !== "object" ? String(s.value.default) : undefined));
const enumOptions = computed(() => (s.value.enum ?? []).map(v => ({ value: String(v), label: f.value.optionLabels?.[String(v)] ?? String(v) })));
const listId = `suggest-${Math.random().toString(36).slice(2)}`;
/** Values suggested while typing: the schema's, or one of the lab's lists. */
const suggestions = computed(() => f.value.suggestions ?? (f.value.suggestionsFrom ? (context().options[f.value.suggestionsFrom] ?? []).map(o => (typeof o === "string" ? o : o.value)) : undefined));
/** An address format: the form's, or a profile setting's `ipv4` type. */
const format = (x: SettingSchema) => x.form?.format ?? (x.type === "ipv4" ? "ip" : undefined);
/** A nested field's `unless`: hidden while its sibling has that value. */
const shown = (child: SettingSchema) => visible(child.form, { ...defaults.value, ...obj.value });
/** Sibling defaults, for `unless` on a field that's unset. */
const defaults = computed(() => Object.fromEntries(Object.entries(s.value.properties ?? {}).flatMap(([k, c]) => (c.default !== undefined ? [[k, c.default]] : []))));
const kind = computed(() => {
  const x = s.value;
  if (f.value.widget) return f.value.widget;
  if (choices.value) return "options";
  if (x.type === "secret") return "secret";
  if (x.type === "credentials") return "credentials";
  if (x.type === "chartValues") return "yaml";
  // The lab's other types (dnsLabel, ipv4, url, …) are strings.
  if (x.type && !JSON_TYPES.includes(x.type)) return "text";
  if (x.enum) return "enum";
  if (x.anyOf || x.oneOf) return "yaml";
  if (x.type === "boolean") return "boolean";
  if (x.type === "integer" || x.type === "number") return "number";
  if (x.type === "string") return "text";
  if (x.type === "array" && x.items?.type === "haulManifest") return "haulManifests";
  if (x.type === "array") return x.items && ["string", "ipv4", "dnsLabel", "dnsName"].includes(x.items.type ?? "") ? "list" : "yaml";
  if (x.type === "object" && x.properties) return "object";
  if (x.type === "object" && typeof x.additionalProperties === "object") {
    const v = x.additionalProperties;
    if (v.type === "string") return "map";
    if (v.type === "boolean") return "boolMap";
  }
  return "yaml";
});
const obj = computed(() => (props.modelValue ?? {}) as Record<string, unknown>);
function setProp(key: string, value: unknown) {
  const next = { ...obj.value, [key]: value };
  if (value === undefined) delete next[key];
  emit("update:modelValue", Object.keys(next).length > 0 ? next : undefined);
}
// The catalog's HaulManifests and the lab's own.
const haulManifests = computed(() => {
  const own = views.value.filter(d => d.kind === "HaulManifest" && d.metadata?.name).map(d => ({ value: String(d.metadata!.name), label: d.metadata?.description }));
  const all = [...(catalog.value?.haulManifests ?? []).map(m => ({ value: m.name, label: m.description })), ...own];
  return all.filter((m, i) => all.findIndex(x => x.value === m.value) === i).sort((a, b) => a.value.localeCompare(b.value));
});
const boolOptions = computed(() => [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
]);
</script>

<template>
  <SelectField v-if="kind === 'options'" :label="label" :hint="hint" :required="required" :problem="problem" :options="choices!" :default-value="defaultString" :empty="placeholder ?? (required ? 'choose…' : 'none')" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <RolesField v-else-if="kind === 'roles'" :label="label" :problem="problem" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <RangeField v-else-if="kind === 'range'" :label="label" :hint="hint" :required="required" :problem="problem" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <AwsCredentialsField v-else-if="kind === 'awsCredentials'" :label="label" :hint="hint" :required="required" :problem="problem" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <SecretField v-else-if="kind === 'secret'" :label="label" :hint="hint" :required="required" :problem="problem" shape="string" :allow-plain="f.plain" :default-value="s.default" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <CredentialsField v-else-if="kind === 'credentials'" :label="label" :hint="hint" :required="required" :problem="problem" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <template v-else-if="kind === 'text'">
    <TextField :format="format(s)" :pattern="format(s) ? undefined : s.pattern" :label="label" :hint="hint" :required="required" :problem="problem" :placeholder="placeholder" :list="suggestions ? listId : undefined" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
    <datalist v-if="suggestions" :id="listId"><option v-for="x in suggestions" :key="x" :value="x" /></datalist>
  </template>
  <TextField v-else-if="kind === 'number'" number :label="label" :hint="hint" :required="required" :problem="problem" :placeholder="placeholder" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <SelectField v-else-if="kind === 'enum'" :label="label" :hint="hint" :required="required" :problem="problem" :options="enumOptions" :default-value="defaultString" :empty="placeholder ?? 'default'" :model-value="modelValue === undefined ? undefined : String(modelValue)" @update:model-value="v => emit('update:modelValue', v)" />
  <SelectField v-else-if="kind === 'boolean'" :label="label" :hint="hint" :options="boolOptions" :default-value="defaultString" :empty="placeholder ?? 'default'" :model-value="modelValue === undefined ? undefined : String(modelValue)" @update:model-value="v => emit('update:modelValue', v === undefined ? undefined : v === 'true')" />
  <ListField v-else-if="kind === 'list'" :format="format(s) ?? (s.items ? format(s.items) : undefined)" :pattern="format(s) ? undefined : s.items?.pattern" :label="label" :hint="hint" :problem="problem" :placeholder="placeholder" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <PickField v-else-if="kind === 'haulManifests'" :label="label" :hint="hint" :options="haulManifests" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <KeyValue v-else-if="kind === 'map' || kind === 'boolMap'" :label="label" :hint="hint" :problem="problem" :boolean="kind === 'boolMap'" :model-value="modelValue as any" @update:model-value="v => emit('update:modelValue', v)" />
  <fieldset v-else-if="kind === 'object'" class="nested">
    <legend>{{ label }}</legend>
    <p v-if="hint" class="field-hint">{{ hint }}</p>
    <template v-for="(child, key) in s.properties" :key="key">
      <SchemaField
        v-if="shown(child)"
        :schema="child"
        :label="String(key)"
        :required="s.required?.includes(String(key)) && child.default === undefined"
        :vars="vars"
        :model-value="obj[key]"
        @update:model-value="v => setProp(String(key), v)"
      />
    </template>
  </fieldset>
  <YamlField v-else :label="label" :hint="hint" :problem="problem" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
</template>
<style scoped>
.nested { grid-column: 1 / -1; }
</style>
