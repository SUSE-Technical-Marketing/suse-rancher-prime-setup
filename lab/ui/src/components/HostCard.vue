<script setup lang="ts">
import { computed, ref } from "vue";
import { addProfile, removeProfile } from "../compose";
import { end, start, target } from "../dnd";
import { catalog, problems, selected, views } from "../store";

// A VM or Machine on the board: drag profiles onto it, drag it to another Harvester or into a
// custom cluster; click it to edit.
const props = defineProps<{ index: number }>();
const emit = defineEmits<{ select: [index: number] }>();

const v = computed(() => views.value[props.index] ?? {});
const spec = computed(() => v.value.spec ?? {});
const isVm = computed(() => v.value.kind === "HarvesterVM");
const defaults = computed(() => catalog.value?.defaults.vm);
const size = computed(() => isVm.value
  ? `${spec.value.cpu ?? defaults.value?.cpu} CPU · ${spec.value.memory ?? defaults.value?.memory} · ${spec.value.disk ?? defaults.value?.disk}`
  : spec.value.address || "no address");
const profiles = computed(() => Object.keys(spec.value.profiles ?? {}));
const isDistro = (n: string) => !!catalog.value?.profiles.find(p => p.name === n)?.distribution;
const over = ref(false);
const drop = target(p => p.type === "profile" && p.from !== props.index && !profiles.value.includes(p.name), p => {
  if (p.type !== "profile") return;
  addProfile(props.index, p.name);
  if (p.from !== undefined) removeProfile(p.from, p.name);
}, on => (over.value = on));
const badge = computed(() => problems.value[props.index]);
</script>

<template>
  <article
    class="host" :class="{ over, active: selected === index }" draggable="true" tabindex="0"
    :aria-label="`${v.kind} ${v.metadata?.name}`"
    @dragstart="start($event, { type: 'host', index })" @dragend="end"
    @click="emit('select', index)" @keydown.enter="emit('select', index)"
    v-on="drop"
  >
    <header>
      <strong>{{ v.metadata?.name || "(no name)" }}</strong>
      <span v-if="badge?.errors" class="badge bad" :title="`${badge.errors} error(s)`">{{ badge.errors }}</span>
      <span v-else-if="badge?.warnings" class="badge warn" :title="`${badge.warnings} warning(s)`">{{ badge.warnings }}</span>
    </header>
    <div class="meta">{{ spec.os || "no OS" }} · {{ size }}</div>
    <div class="chips">
      <span
        v-for="p in profiles" :key="p" class="chip" :class="{ distro: isDistro(p) }" draggable="true"
        :title="`${p}: drag to another host, or back to the palette to remove`"
        @dragstart.stop="start($event, { type: 'profile', name: p, from: index })" @dragend="end"
      >{{ p }}<button type="button" class="x" :aria-label="`Remove ${p}`" @click.stop="removeProfile(index, p)">×</button></span>
      <span v-if="profiles.length === 0" class="muted small">drop profiles here</span>
    </div>
  </article>
</template>
