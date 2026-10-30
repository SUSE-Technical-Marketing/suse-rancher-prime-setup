<script setup lang="ts">
import { computed } from "vue";
import SecretField from "./SecretField.vue";

// AWS keys: one secret holding accessKey and secretKey ("{{ secrets.aws }}"), or the two fields.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; required?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const FIELDS = ["accessKey", "secretKey"];
const split = computed(() => typeof props.modelValue === "object" && props.modelValue !== null);
const value = computed(() => props.modelValue as { accessKey?: unknown; secretKey?: unknown } | undefined);
</script>

<template>
  <div class="cred">
    <SecretField v-if="!split" :model-value="modelValue" :label="label" :hint="hint ?? 'a secret with accessKey and secretKey'" :required="required" :fields="FIELDS" :allow-plain="false" @update:model-value="v => emit('update:modelValue', v)" />
    <template v-else>
      <SecretField :label="`${label} access key`" :model-value="value?.accessKey" shape="string" @update:model-value="v => emit('update:modelValue', { ...value, accessKey: v })" />
      <SecretField :label="`${label} secret key`" :model-value="value?.secretKey" shape="string" @update:model-value="v => emit('update:modelValue', { ...value, secretKey: v })" />
    </template>
    <button type="button" class="link" @click="emit('update:modelValue', split ? undefined : { accessKey: undefined, secretKey: undefined })">
      {{ split ? "use one secret" : "two separate secrets" }}
    </button>
  </div>
</template>
