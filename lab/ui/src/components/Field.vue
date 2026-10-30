<script setup lang="ts">
// A labelled row: the label, the control (slot), and an optional hint below.
defineProps<{ label?: string; hint?: string; required?: boolean; wide?: boolean }>();
</script>

<template>
  <label class="field" :class="{ wide }">
    <span v-if="label" class="field-label">{{ label }}<span v-if="required" class="req" title="required">*</span></span>
    <span class="field-control"><slot /></span>
    <span v-if="hint" class="field-hint">{{ hint }}</span>
  </label>
</template>
