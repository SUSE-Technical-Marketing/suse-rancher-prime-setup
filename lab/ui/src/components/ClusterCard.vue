<script setup lang="ts">
import { computed, ref } from "vue";
import { addK3k, addNode, runsKubernetes } from "../compose";
import { target } from "../dnd";
import { catalog, problems, selected, views } from "../store";

// A downstream cluster on the board. A custom cluster takes hosts dropped on it as nodes; any
// cluster takes a k3k block, and shows the k3k clusters that run in it.
const props = defineProps<{ index: number }>();
const emit = defineEmits<{ select: [index: number] }>();

const v = computed(() => views.value[props.index] ?? {});
const spec = computed(() => v.value.spec ?? {});
const custom = computed(() => spec.value.type === "custom");
const defaults = computed(() => catalog.value?.defaults.vm);
const pools = computed<any[]>(() => spec.value.pools ?? []);
const nodes = computed<any[]>(() => spec.value.nodes ?? []);
const labels = computed(() => Object.entries(spec.value.labels ?? {}).map(([k, val]) => `${k}=${val}`));
const over = ref(false);
const virtuals = computed(() => views.value.map((d, index) => ({ d, index })).filter(x => x.d.kind === "DownstreamCluster" && x.d.spec?.type === "k3k" && x.d.spec?.parent === v.value.metadata?.name));
const drop = target(p => {
  if (p.type === "block") return p.block === "K3kCluster";
  if (!custom.value || p.type !== "host") return false;
  const host = views.value[p.index];
  return !runsKubernetes(p.index) && !nodes.value.some(n => n.host === host?.metadata?.name);
}, p => {
  if (p.type === "block") addK3k(v.value.metadata?.name ?? "");
  else if (p.type === "host") addNode(props.index, views.value[p.index]?.metadata?.name ?? "");
}, on => (over.value = on));
const badge = computed(() => problems.value[props.index]);
</script>

<template>
  <article class="cluster" :class="{ over, active: selected === index }" tabindex="0" @click="emit('select', index)" @keydown.enter="emit('select', index)" v-on="drop">
    <header>
      <span class="ckind">{{ custom ? "custom" : "provisioned" }} · {{ spec.distro ?? "rke2" }}</span>
      <strong>{{ v.metadata?.name || "(no name)" }}</strong>
      <span v-if="badge?.errors" class="badge bad">{{ badge.errors }}</span>
      <span v-else-if="badge?.warnings" class="badge warn">{{ badge.warnings }}</span>
    </header>
    <div class="meta">managed by {{ spec.rancher || "—" }}</div>
    <div v-if="!custom" class="pools">
      <div v-for="(p, i) in pools" :key="i" class="pool">
        <span class="stack" :title="`${p.quantity ?? 1} machine(s), created by Rancher`">
          <span v-for="n in Math.min(p.quantity ?? 1, 5)" :key="n" class="vmbox" />
          <span v-if="(p.quantity ?? 1) > 5" class="more">+{{ (p.quantity ?? 1) - 5 }}</span>
        </span>
        <span>
          <strong>{{ p.name }}</strong> · {{ p.cpu ?? defaults?.cpu }} CPU · {{ p.memory ?? defaults?.memory }} · {{ p.disk ?? defaults?.disk }}
          <span class="muted">{{ (p.roles ?? []).join(", ") }}</span>
        </span>
      </div>
    </div>
    <div v-else class="chips">
      <span v-for="n in nodes" :key="n.host" class="chip">{{ n.host }}</span>
      <span class="muted small">{{ nodes.length ? "" : "drop hosts here to add them as nodes" }}</span>
    </div>
    <div v-if="labels.length" class="chips">
      <span v-for="l in labels" :key="l" class="chip label">{{ l }}</span>
    </div>
    <div v-if="virtuals.length" class="virtuals">
      <article
        v-for="x in virtuals" :key="x.index" class="virtual" :class="{ active: selected === x.index }" tabindex="0"
        @click.stop="emit('select', x.index)" @keydown.enter.stop="emit('select', x.index)"
      >
        <span class="ckind">k3k · {{ x.d.spec?.mode ?? "shared" }}</span>
        <strong>{{ x.d.metadata?.name || "(no name)" }}</strong>
        <span class="muted small">{{ x.d.spec?.servers ?? 1 }} server · {{ x.d.spec?.agents ?? 0 }} agents · {{ x.d.spec?.namespace ?? `k3k-${x.d.metadata?.name}` }}</span>
        <span v-if="problems[x.index]?.errors" class="badge bad">{{ problems[x.index].errors }}</span>
      </article>
    </div>
  </article>
</template>

<style scoped>
.virtuals { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.virtual { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; padding: 6px 10px; border: 1px dashed var(--border); border-radius: 6px; background: var(--panel); cursor: pointer; }
.virtual.active { border-style: solid; border-color: var(--accent); }
</style>
