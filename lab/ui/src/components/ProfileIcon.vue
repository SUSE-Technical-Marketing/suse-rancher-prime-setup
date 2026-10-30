<script lang="ts">
/** Distinct hues that read on light and dark panels; a profile's is its place in the catalog. */
export const PROFILE_COLORS = ["#1f8a5b", "#2f6fdb", "#c2410c", "#8a5cd6", "#0e8a9a", "#b45309", "#c0367a", "#4d7c0f", "#475569", "#0369a1", "#9f1239", "#7c3aed"];
</script>

<script setup lang="ts">
import { computed } from "vue";
import { iconRef } from "../icons";
import { catalog } from "../store";

// A profile's icon in its color: a round token. `size` is its diameter in pixels.
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 26 });

const index = computed(() => (catalog.value?.profiles ?? []).findIndex(p => p.name === props.name));
const profile = computed(() => catalog.value?.profiles[index.value]);
const color = computed(() => (index.value < 0 ? "#6b7280" : PROFILE_COLORS[index.value % PROFILE_COLORS.length]));
const icon = computed(() => iconRef(profile.value?.icon ?? "puzzle").value);
</script>

<template>
  <span class="picon" :style="{ '--c': color, width: `${size}px`, height: `${size}px` }" role="img" :aria-label="name">
    <component :is="icon" v-if="icon" :size="Math.round(size * 0.58)" :stroke-width="2" aria-hidden="true" />
  </span>
</template>

<style scoped>
.picon {
  --ink: var(--c);
  display: inline-flex; align-items: center; justify-content: center; flex: none; border-radius: 50%;
  color: var(--ink); background: color-mix(in srgb, var(--c) 16%, var(--panel)); border: 1.5px solid var(--ink);
}
/* The same hues, lighter, on dark panels. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .picon { --ink: color-mix(in srgb, var(--c) 55%, white); background: color-mix(in srgb, var(--c) 30%, var(--panel)); }
}
:root[data-theme="dark"] .picon { --ink: color-mix(in srgb, var(--c) 55%, white); background: color-mix(in srgb, var(--c) 30%, var(--panel)); }
</style>
