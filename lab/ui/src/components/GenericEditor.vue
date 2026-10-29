<script setup lang="ts">
import { useDoc } from "../doc";
import DocHeader from "./DocHeader.vue";
import YamlField from "./YamlField.vue";

// Any other document (catalog overrides: HelmChart, OperatingSystem, Defaults, ...), as YAML.
const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
</script>

<template>
  <div class="editor">
    <DocHeader :kind="v.kind ?? '?'" :name="v.metadata?.name" with-description :description="v.metadata?.description" @name="x => set('metadata.name', x)" @description="x => set('metadata.description', x)" />
    <section>
      <p class="muted">A catalog document in the lab file: it overrides or adds to the catalog for this lab (see DESIGN.md §17).</p>
      <YamlField label="spec" :rows="16" v-bind="bind('spec')" />
    </section>
  </div>
</template>
