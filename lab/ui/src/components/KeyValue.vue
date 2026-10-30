<script setup lang="ts">
import { ref, watch } from "vue";
import Field from "./Field.vue";

// A map of strings (labels, annotations, Rancher settings) or of booleans (feature flags).
const props = defineProps<{ modelValue?: Record<string, unknown>; label?: string; hint?: string; boolean?: boolean; keyPlaceholder?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: Record<string, unknown> | undefined] }>();

const rows = ref<{ key: string; value: string }[]>([]);
watch(() => props.modelValue, v => {
  rows.value = Object.entries(v ?? {}).map(([key, value]) => ({ key, value: String(value) }));
}, { immediate: true });

function commit() {
  const out: Record<string, unknown> = {};
  for (const r of rows.value) {
    if (!r.key.trim()) continue;
    out[r.key.trim()] = props.boolean ? r.value === "true" : r.value;
  }
  emit("update:modelValue", Object.keys(out).length > 0 ? out : undefined);
}
function add() {
  rows.value.push({ key: "", value: props.boolean ? "true" : "" });
}
function drop(i: number) {
  rows.value.splice(i, 1);
  commit();
}
</script>

<template>
  <Field :label="label" :hint="hint" wide>
    <div class="kv">
      <div v-for="(r, i) in rows" :key="i" class="kv-row">
        <input v-model="r.key" :placeholder="keyPlaceholder ?? 'key'" spellcheck="false" @change="commit" />
        <select v-if="boolean" v-model="r.value" @change="commit">
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        <input v-else v-model="r.value" placeholder="value" spellcheck="false" @change="commit" />
        <button type="button" class="icon" title="Remove" @click="drop(i)">×</button>
      </div>
      <button type="button" class="link" @click="add">+ add</button>
    </div>
  </Field>
</template>
