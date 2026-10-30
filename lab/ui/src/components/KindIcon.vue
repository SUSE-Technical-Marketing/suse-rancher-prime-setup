<script setup lang="ts">
import { computed } from "vue";
import { iconRef } from "../icons";

// A block's or box's icon in its category's color (`--cat`, set by the caller's category class).
const props = withDefaults(defineProps<{ icon: string; size?: number }>(), { size: 16 });
const component = computed(() => iconRef(props.icon).value);
</script>

<template>
  <component :is="component" v-if="component" class="kicon" :size="size" :stroke-width="2" aria-hidden="true" />
  <span v-else class="kicon" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true" />
</template>

<style scoped>
.kicon { flex: none; color: var(--cat, var(--muted)); display: inline-block; }
</style>
