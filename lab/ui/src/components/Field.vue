<script setup lang="ts">
// A labelled row: the label, the control (slot), and an optional hint below; a problem replaces the hint.
defineProps<{ label?: string; hint?: string; required?: boolean; wide?: boolean; problem?: string }>();
</script>

<template>
  <label class="field" :class="{ wide, invalid: !!problem }">
    <span v-if="label" class="field-label">{{ label }}<span v-if="required" class="req" title="required">*</span></span>
    <span class="field-control"><slot /></span>
    <span v-if="problem" class="field-problem">{{ problem }}</span>
    <span v-else-if="hint" class="field-hint">{{ hint }}</span>
  </label>
</template>
