<script setup lang="ts">
import TextField from "./TextField.vue";

// A document's kind and name (`metadata.name`), and an optional description.
defineProps<{ kind: string; name?: string; description?: string; nameHint?: string; withDescription?: boolean }>();
const emit = defineEmits<{ name: [value: unknown]; description: [value: unknown] }>();
</script>

<template>
  <header class="doc-header">
    <span class="kind">{{ kind }}</span>
    <div class="grid">
      <TextField label="name" :hint="nameHint" required :model-value="name" @update:model-value="v => emit('name', v)" />
      <TextField v-if="withDescription" label="description" :model-value="description" @update:model-value="v => emit('description', v)" />
    </div>
  </header>
</template>
