<script setup lang="ts">
import ProfileIcon from "./ProfileIcon.vue";
import { computed, ref } from "vue";
import { addBlock, removeProfile } from "../compose";
import { dragging, end, start, target, type Block } from "../dnd";
import { catalog } from "../store";

// Building blocks and profiles to drag onto the board. A block can also be clicked: it goes on the
// first Harvester. A profile chip dragged back here comes off its host.
const BLOCKS: { block: Block; label: string; hint: string }[] = [
  { block: "Harvester", label: "Harvester", hint: "a Harvester the lab uses: drop on the board" },
  { block: "HarvesterVM", label: "VM", hint: "a VM: drop on a Harvester" },
  { block: "RancherVM", label: "Rancher VM", hint: "k3s, cert-manager, Traefik and Rancher: drop on a Harvester" },
  { block: "Machine", label: "Machine", hint: "an existing machine, reached over SSH: drop on the board" },
  { block: "DownstreamCluster", label: "Downstream cluster", hint: "a cluster Rancher creates: drop on a Harvester" },
  { block: "K3kCluster", label: "k3k cluster", hint: "a virtual cluster inside another, imported into Rancher: drop on a cluster" },
];

const filter = ref("");
const profiles = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return (catalog.value?.profiles ?? []).filter(p => !f || p.name.includes(f) || p.description.toLowerCase().includes(f));
});
const over = ref(false);
const trash = target(p => p.type === "profile" && p.from !== undefined, p => {
  if (p.type === "profile" && p.from !== undefined) removeProfile(p.from, p.name);
}, on => (over.value = on));
const removing = computed(() => dragging.value?.type === "profile" && dragging.value.from !== undefined);
</script>

<template>
  <nav class="palette" :class="{ removing, over }" v-on="trash">
    <p v-if="removing" class="trash-hint">Drop here to remove the profile</p>
    <h4>Blocks</h4>
    <button
      v-for="b in BLOCKS" :key="b.block" type="button" class="block" draggable="true" :title="b.hint"
      @dragstart="start($event, { type: 'block', block: b.block })" @dragend="end" @click="addBlock(b.block)"
    >
      <span class="grip" aria-hidden="true">⠿</span>{{ b.label }}
    </button>

    <h4>Profiles</h4>
    <input v-model="filter" class="filter" placeholder="filter…" spellcheck="false" />
    <div
      v-for="p in profiles" :key="p.name" class="pchip" draggable="true" :title="`${p.description}\nprovides: ${p.provides.join(', ') || '—'}\nneeds: ${p.requires.join(', ') || '—'}`"
      @dragstart="start($event, { type: 'profile', name: p.name })" @dragend="end"
    >
      <ProfileIcon :name="p.name" :size="22" class="pi" />
      <span class="pname">{{ p.name }}</span>
      <span class="pdesc">{{ p.description }}</span>
    </div>
  </nav>
</template>
