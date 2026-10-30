<script setup lang="ts">
import { computed } from "vue";
import SecretField from "./SecretField.vue";
import TextField from "./TextField.vue";

// Credentials: one secret holding a username and password ("{{ secrets.harbor }}"), or a username with a password secret.
const props = defineProps<{ modelValue?: unknown; label?: string; hint?: string; required?: boolean; problem?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const split = computed(() => typeof props.modelValue === "object" && props.modelValue !== null && "username" in props.modelValue);
const value = computed(() => props.modelValue as { username?: string; password?: unknown } | undefined);
</script>

<template>
  <div class="cred">
    <SecretField v-if="!split" :model-value="modelValue" :label="label" :hint="hint" :required="required" shape="credentials" :problem="problem" :allow-plain="false" @update:model-value="v => emit('update:modelValue', v)" />
    <template v-else>
      <TextField :label="`${label} user`" :model-value="value?.username" @update:model-value="v => emit('update:modelValue', { ...value, username: v })" />
      <SecretField :label="`${label} password`" :model-value="value?.password" shape="string" @update:model-value="v => emit('update:modelValue', { ...value, password: v })" />
    </template>
    <button type="button" class="link" @click="emit('update:modelValue', split ? undefined : { username: '', password: undefined })">
      {{ split ? "use one secret" : "username + password secret" }}
    </button>
  </div>
</template>
