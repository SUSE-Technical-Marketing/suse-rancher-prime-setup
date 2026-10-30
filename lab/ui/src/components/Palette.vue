<script setup lang="ts">
import ProfileIcon from "./ProfileIcon.vue";
import KindIcon from "./KindIcon.vue";
import { computed, ref } from "vue";
import { addBlock, removeProfile } from "../compose";
import { dragging, end, start, target, type Block } from "../dnd";
import { BLOCK_KIND, CATEGORIES } from "../kinds";
import { catalog } from "../store";

// Building blocks, by category, and profiles to drag onto the board. A block can also be clicked:
// it goes on the first Harvester or AWS site. A profile chip dragged back here comes off its host.
const BLOCKS: { block: Block; label: string; hint: string }[] = [
  { block: "Harvester", label: "Harvester", hint: "a Harvester the lab uses: drop on the board" },
  { block: "HarvesterVM", label: "VM", hint: "a VM: drop on a Harvester" },
  { block: "RancherVM", label: "Rancher VM", hint: "k3s, cert-manager, Traefik and Rancher: drop on a Harvester" },
  { block: "Machine", label: "Machine", hint: "an existing machine, reached over SSH: drop on the board" },
  { block: "DownstreamCluster", label: "Harvester cluster", hint: "a cluster Rancher creates from VMs on a Harvester: drop on a Harvester" },
  { block: "AwsSite", label: "AWS site", hint: "an AWS account and region; the lab gets its own VPC there: drop on the board" },
  { block: "Ec2Cluster", label: "EC2 cluster", hint: "machines Rancher creates on AWS (needs a public Rancher): drop on an AWS site" },
  { block: "EksCluster", label: "EKS cluster", hint: "an EKS cluster Rancher creates and manages (needs a public Rancher): drop on an AWS site" },
  { block: "MetalCluster", label: "Metal cluster", hint: "Rancher installs Kubernetes on the lab's Machines or bare VMs: drop on one, then drop more on the cluster" },
  { block: "K3kCluster", label: "k3k cluster", hint: "a virtual cluster inside another, imported into Rancher: drop on a cluster" },
];

/** The blocks under each category's heading; k3k clusters are among the clusters. */
const groups = CATEGORIES.map(c => ({ ...c, blocks: BLOCKS.filter(b => (BLOCK_KIND[b.block].category === "virtual" ? "cluster" : BLOCK_KIND[b.block].category) === c.id) }));

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
    <section v-for="g in groups" :key="g.id" class="pgroup" :class="`cat-${g.id}`">
      <h4 :title="g.hint">{{ g.label }}</h4>
      <button
        v-for="b in g.blocks" :key="b.block" type="button" class="block" draggable="true" :title="b.hint"
        :class="[`cat-${BLOCK_KIND[b.block].category}`, `blk-${b.block}`]"
        @dragstart="start($event, { type: 'block', block: b.block })" @dragend="end" @click="addBlock(b.block)"
      >
        <KindIcon :icon="BLOCK_KIND[b.block].icon" />{{ b.label }}
      </button>
    </section>

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
