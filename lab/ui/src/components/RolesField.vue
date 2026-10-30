<script setup lang="ts">
import Field from "./Field.vue";

const ROLES = ["etcd", "controlplane", "worker"] as const;
const props = defineProps<{ modelValue?: unknown; label?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string[] | undefined] }>();
const has = (r: string) => Array.isArray(props.modelValue) && props.modelValue.includes(r);
function toggle(r: string) {
  const next = ROLES.filter(x => (x === r ? !has(x) : has(x)));
  emit("update:modelValue", next.length > 0 ? [...next] : undefined);
}
</script>

<template>
  <Field :label="label ?? 'roles'" required>
    <span class="roles">
      <label v-for="r in ROLES" :key="r" class="check"><input type="checkbox" :checked="has(r)" @change="toggle(r)" /> {{ r }}</label>
    </span>
  </Field>
</template>
