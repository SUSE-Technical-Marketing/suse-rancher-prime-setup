<script setup lang="ts">
import { computed } from "vue";
import type { SettingSchema } from "../api";
import CredentialsField from "./CredentialsField.vue";
import KeyValue from "./KeyValue.vue";
import ListField from "./ListField.vue";
import SecretField from "./SecretField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

// One setting, its control chosen from its schema. Objects with properties nest; what has no
// simple control (anyOf, chart values, lists of objects) is edited as YAML.
const props = defineProps<{ schema: SettingSchema; modelValue?: unknown; label: string; required?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const s = computed(() => props.schema);
const hint = computed(() => s.value.description);
const placeholder = computed(() => (s.value.default !== undefined && typeof s.value.default !== "object" ? `default ${s.value.default}` : undefined));
const kind = computed(() => {
  const x = s.value;
  if (x.$ref === "secretOrString") return "secret";
  if (x.$ref === "credentials") return "credentials";
  if (x.$ref === "chartValues") return "yaml";
  if (x.$ref) return "text";
  if (x.enum) return "enum";
  if (x.anyOf || x.oneOf) return "yaml";
  if (x.type === "boolean") return "boolean";
  if (x.type === "integer" || x.type === "number") return "number";
  if (x.type === "string") return "text";
  if (x.type === "array") return x.items && (x.items.type === "string" || x.items.$ref === "ipv4" || x.items.$ref === "dnsLabel" || x.items.$ref === "dnsName") ? "list" : "yaml";
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
const boolOptions = computed(() => [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
]);
</script>

<template>
  <SecretField v-if="kind === 'secret'" :label="label" :hint="hint" :required="required" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <CredentialsField v-else-if="kind === 'credentials'" :label="label" :hint="hint" :required="required" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <TextField v-else-if="kind === 'text'" :format="s.$ref === 'ipv4' ? 'ip' : undefined" :pattern="s.pattern" :label="label" :hint="hint" :required="required" :placeholder="placeholder" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <TextField v-else-if="kind === 'number'" number :label="label" :hint="hint" :required="required" :placeholder="placeholder" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <SelectField v-else-if="kind === 'enum'" :label="label" :hint="hint" :required="required" :options="(s.enum ?? []).map(String)" :empty="placeholder ?? 'default'" :model-value="modelValue === undefined ? undefined : String(modelValue)" @update:model-value="v => emit('update:modelValue', v)" />
  <SelectField v-else-if="kind === 'boolean'" :label="label" :hint="hint" :options="boolOptions" :empty="placeholder ?? 'default'" :model-value="modelValue === undefined ? undefined : String(modelValue)" @update:model-value="v => emit('update:modelValue', v === undefined ? undefined : v === 'true')" />
  <ListField v-else-if="kind === 'list'" :format="s.items?.$ref === 'ipv4' ? 'ip' : undefined" :pattern="s.items?.pattern" :label="label" :hint="hint" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
  <KeyValue v-else-if="kind === 'map' || kind === 'boolMap'" :label="label" :hint="hint" :boolean="kind === 'boolMap'" :model-value="modelValue as any" @update:model-value="v => emit('update:modelValue', v)" />
  <fieldset v-else-if="kind === 'object'" class="nested">
    <legend>{{ label }}</legend>
    <p v-if="hint" class="field-hint">{{ hint }}</p>
    <SchemaField
      v-for="(child, key) in s.properties"
      :key="key"
      :schema="child"
      :label="String(key)"
      :required="s.required?.includes(String(key))"
      :model-value="obj[key]"
      @update:model-value="v => setProp(String(key), v)"
    />
  </fieldset>
  <YamlField v-else :label="label" :hint="hint" :model-value="modelValue" @update:model-value="v => emit('update:modelValue', v)" />
</template>
<style scoped>
.nested { grid-column: 1 / -1; }
</style>
