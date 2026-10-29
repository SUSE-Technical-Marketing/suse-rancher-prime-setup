<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { addBlock, defaultNetwork, moveVm, placeOf } from "../compose";
import { dragging, target, type Payload } from "../dnd";
import { problems, selected, views } from "../store";
import ClusterCard from "./ClusterCard.vue";
import HostCard from "./HostCard.vue";

// The lab as a topology map, laid out from the lab itself (nothing about positions goes in the
// file): each Harvester is a region with a lane per network, holding the VMs on it and the clusters
// Rancher creates there; existing machines and custom clusters sit below. Lines show which Rancher
// manages which cluster, and which hosts a custom cluster is made of.
const emit = defineEmits<{ select: [index: number] }>();

const docs = computed(() => views.value.map((v, index) => ({ v, index })));
const lab = computed(() => docs.value.find(d => d.v.kind === "Lab"));
const harvesters = computed(() => docs.value.filter(d => d.v.kind === "Harvester"));
const names = computed(() => new Set(harvesters.value.map(h => h.v.metadata?.name)));
// k3k clusters show inside their parent's card.
const placed = computed(() => docs.value.filter(d => d.v.kind === "HarvesterVM" || (d.v.kind === "DownstreamCluster" && d.v.spec?.type !== "custom" && d.v.spec?.type !== "k3k")));
const inLane = (harvester: string, lane: string) => placed.value.filter(d => {
  const at = placeOf(d.index);
  return at.harvester === harvester && at.network === lane;
});
const strays = computed(() => placed.value.filter(d => !names.value.has(d.v.spec?.harvester) || !lanesOf(d.v.spec?.harvester).some(l => l.name === placeOf(d.index).network)));
const machines = computed(() => docs.value.filter(d => d.v.kind === "Machine"));
const custom = computed(() => docs.value.filter(d => d.v.kind === "DownstreamCluster" && d.v.spec?.type === "custom"));
const others = computed(() => docs.value.filter(d => !["Lab", "Harvester", "HarvesterVM", "Machine", "DownstreamCluster"].includes(d.v.kind ?? "")));

interface Lane { name: string; isDefault: boolean; dhcp?: string; lb?: string }
/** A Harvester's networks; the untagged one only when it's used or configured. */
function lanesOf(harvester?: string): Lane[] {
  const spec = views.value.find(v => v.kind === "Harvester" && v.metadata?.name === harvester)?.spec ?? {};
  const def = defaultNetwork(harvester);
  const range = (r?: string[]) => (r && r.length === 2 ? `${r[0]} – ${r[1]}` : undefined);
  const untagged = spec.networks?.untagged ?? {};
  const lanes: Lane[] = ((spec.networks?.vlans ?? []) as any[]).map(n => ({
    name: `vlan${n.id}`, isDefault: def === `vlan${n.id}`, dhcp: n.dhcp?.cidr, lb: range(n.loadBalancer?.range),
  }));
  const used = placed.value.some(d => d.v.spec?.harvester === harvester && placeOf(d.index).network === "untagged");
  if (def === "untagged" || used || untagged.dhcp || untagged.loadBalancer || lanes.length === 0) {
    lanes.unshift({ name: "untagged", isDefault: def === "untagged", dhcp: untagged.dhcp?.cidr, lb: range(untagged.loadBalancer?.range) });
  }
  return lanes;
}

// --- Drops ------------------------------------------------------------------------------------
const NEW_ON_HARVESTER = ["HarvesterVM", "RancherVM", "DownstreamCluster"];
const overLane = ref<string>();
/** A lane takes new VMs and clusters, and VMs from elsewhere (which then change network or Harvester). */
function onLane(harvester: string, lane: string) {
  const key = `${harvester}/${lane}`;
  return target(
    (p: Payload) => (p.type === "block" && NEW_ON_HARVESTER.includes(p.block))
      || (p.type === "host" && views.value[p.index]?.kind === "HarvesterVM" && (placeOf(p.index).harvester !== harvester || placeOf(p.index).network !== lane)),
    p => {
      if (p.type === "block") addBlock(p.block, harvester, lane);
      else if (p.type === "host") moveVm(p.index, harvester, lane);
    },
    on => (overLane.value = on ? key : overLane.value === key ? undefined : overLane.value),
  );
}
const wantsLane = computed(() => (dragging.value?.type === "block" && NEW_ON_HARVESTER.includes(dragging.value.block)) || (dragging.value?.type === "host" && views.value[dragging.value.index]?.kind === "HarvesterVM"));
const overMap = ref(false);
const onMap = target(p => p.type === "block" && (p.block === "Harvester" || p.block === "Machine"), p => {
  if (p.type === "block") addBlock(p.block);
}, on => (overMap.value = on));
const wantsMap = computed(() => dragging.value?.type === "block" && (dragging.value.block === "Harvester" || dragging.value.block === "Machine"));

// --- Lines ------------------------------------------------------------------------------------
type Kind = "manages" | "node";
const relations = computed(() => {
  const byName = (name?: string) => docs.value.find(d => (d.v.kind === "HarvesterVM" || d.v.kind === "Machine") && d.v.metadata?.name === name)?.index;
  const out: { from: number; to: number; kind: Kind }[] = [];
  for (const d of docs.value) {
    // A k3k cluster sits in its parent, which has the same Rancher.
    if (d.v.kind !== "DownstreamCluster" || d.v.spec?.type === "k3k") continue;
    const rancher = byName(d.v.spec?.rancher);
    if (rancher !== undefined) out.push({ from: rancher, to: d.index, kind: "manages" });
    if (d.v.spec?.type === "custom") {
      for (const n of (d.v.spec?.nodes ?? []) as { host?: string }[]) {
        const host = byName(n.host);
        if (host !== undefined) out.push({ from: d.index, to: host, kind: "node" });
      }
    }
  }
  return out;
});

const root = ref<HTMLElement>();
const lines = ref<{ key: string; d: string; kind: Kind }[]>([]);
const size = ref({ w: 0, h: 0 });

/** A curve from one card's edge to the other's, leaving on the side that faces it. */
function curve(a: DOMRect, b: DOMRect, base: DOMRect): string {
  const ax = a.left + a.width / 2 - base.left, ay = a.top + a.height / 2 - base.top;
  const bx = b.left + b.width / 2 - base.left, by = b.top + b.height / 2 - base.top;
  let x1 = ax, y1 = ay, x2 = bx, y2 = by, vertical = true;
  if (b.top >= a.bottom) { y1 = a.bottom - base.top; y2 = b.top - base.top; }
  else if (b.bottom <= a.top) { y1 = a.top - base.top; y2 = b.bottom - base.top; }
  else {
    vertical = false;
    if (b.left >= a.right) { x1 = a.right - base.left; x2 = b.left - base.left; }
    else { x1 = a.left - base.left; x2 = b.right - base.left; }
  }
  const bend = Math.max(40, (vertical ? Math.abs(y2 - y1) : Math.abs(x2 - x1)) / 2);
  return vertical
    ? `M ${x1} ${y1} C ${x1} ${y1 + Math.sign(y2 - y1) * bend}, ${x2} ${y2 - Math.sign(y2 - y1) * bend}, ${x2} ${y2}`
    : `M ${x1} ${y1} C ${x1 + Math.sign(x2 - x1) * bend} ${y1}, ${x2 - Math.sign(x2 - x1) * bend} ${y2}, ${x2} ${y2}`;
}

function draw() {
  const el = root.value;
  if (!el) return;
  const base = el.getBoundingClientRect();
  const box = (i: number) => el.querySelector(`[data-node="${i}"]`)?.getBoundingClientRect();
  lines.value = relations.value.flatMap(r => {
    const a = box(r.from), b = box(r.to);
    return a && b ? [{ key: `${r.kind}-${r.from}-${r.to}`, d: curve(a, b, base), kind: r.kind }] : [];
  });
  size.value = { w: el.scrollWidth, h: el.scrollHeight };
}
const redraw = () => nextTick(() => requestAnimationFrame(draw));
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(redraw);
  if (root.value) observer.observe(root.value);
  window.addEventListener("resize", redraw);
  document.fonts?.ready.then(redraw);
  redraw();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  window.removeEventListener("resize", redraw);
});
watch(views, redraw);

const badge = (i: number) => problems.value[i];
</script>

<template>
  <div ref="root" class="map" :class="{ over: overMap, wants: wantsMap }" v-on="onMap">
    <div class="map-top">
      <article v-if="lab" class="labcard" :class="{ active: selected === lab.index }" tabindex="0" @click="emit('select', lab.index)" @keydown.enter="emit('select', lab.index)">
        <span class="ckind">Lab</span>
        <strong>{{ lab.v.metadata?.name || "(no name)" }}</strong>
        <span class="muted">{{ lab.v.spec?.domain || "no domain" }} · TLS {{ lab.v.spec?.tls?.acme ?? "letsencrypt" }} · ssh {{ lab.v.spec?.ssh?.user ?? "default user" }}</span>
        <span v-if="badge(lab.index)?.errors" class="badge bad">{{ badge(lab.index).errors }}</span>
      </article>
      <div class="legend" aria-hidden="true">
        <span><svg width="28" height="8"><path d="M0 4 H24" class="edge manages" marker-end="url(#arrow-manages)" /></svg> manages</span>
        <span><svg width="28" height="8"><path d="M0 4 H28" class="edge node" /></svg> cluster node</span>
      </div>
    </div>

    <section v-for="h in harvesters" :key="h.index" class="region">
      <header :class="{ active: selected === h.index }" tabindex="0" @click="emit('select', h.index)" @keydown.enter="emit('select', h.index)">
        <span class="ckind">Harvester</span>
        <strong>{{ h.v.metadata?.name }}</strong>
        <span v-if="h.v.spec?.dns?.host" class="muted">DNS {{ h.v.spec.dns.backend }} {{ h.v.spec.dns.host }}</span>
        <span v-if="badge(h.index)?.errors" class="badge bad">{{ badge(h.index).errors }}</span>
      </header>
      <div class="lanes">
        <div
          v-for="lane in lanesOf(h.v.metadata?.name)" :key="lane.name" class="lane"
          :class="{ over: overLane === `${h.v.metadata?.name}/${lane.name}`, wants: wantsLane }"
          v-on="onLane(h.v.metadata?.name ?? '', lane.name)"
        >
          <div class="lane-head">
            <strong>{{ lane.name }}</strong>
            <span v-if="lane.isDefault" class="chip">default</span>
            <span v-if="lane.dhcp" class="muted small">DHCP {{ lane.dhcp }}</span>
            <span v-if="lane.lb" class="muted small">LB {{ lane.lb }}</span>
          </div>
          <template v-for="d in inLane(h.v.metadata?.name ?? '', lane.name)" :key="d.index">
            <HostCard v-if="d.v.kind === 'HarvesterVM'" :index="d.index" :data-node="d.index" @select="i => emit('select', i)" />
            <ClusterCard v-else :index="d.index" :data-node="d.index" @select="i => emit('select', i)" />
          </template>
          <p v-if="!inLane(h.v.metadata?.name ?? '', lane.name).length" class="empty">drop VMs or clusters here</p>
        </div>
      </div>
    </section>
    <p v-if="!harvesters.length" class="empty big">Drag a Harvester here to start, or a Machine for existing hosts</p>

    <section v-if="strays.length" class="region stray">
      <header><span class="ckind">not on a network of this lab</span><span class="muted">drag VMs onto a lane; fix a cluster's Harvester in its form</span></header>
      <div class="cards">
        <template v-for="d in strays" :key="d.index">
          <HostCard v-if="d.v.kind === 'HarvesterVM'" :index="d.index" :data-node="d.index" @select="i => emit('select', i)" />
          <ClusterCard v-else :index="d.index" :data-node="d.index" @select="i => emit('select', i)" />
        </template>
      </div>
    </section>

    <div v-if="machines.length || custom.length" class="map-bottom">
      <section v-if="machines.length" class="region outside">
        <header><span class="ckind">Existing machines</span><span class="muted">reached over SSH</span></header>
        <div class="cards">
          <HostCard v-for="m in machines" :key="m.index" :index="m.index" :data-node="m.index" @select="i => emit('select', i)" />
        </div>
      </section>
      <section v-if="custom.length" class="region outside">
        <header><span class="ckind">Custom clusters</span><span class="muted">drop hosts on one to add nodes</span></header>
        <div class="cards">
          <ClusterCard v-for="c in custom" :key="c.index" :index="c.index" :data-node="c.index" @select="i => emit('select', i)" />
        </div>
      </section>
    </div>

    <section v-if="others.length" class="group">
      <h4>Other documents</h4>
      <div class="cards">
        <article v-for="o in others" :key="o.index" class="host" :class="{ active: selected === o.index }" tabindex="0" @click="emit('select', o.index)" @keydown.enter="emit('select', o.index)">
          <header><strong>{{ o.v.metadata?.name }}</strong></header>
          <div class="meta">{{ o.v.kind }}</div>
        </article>
      </div>
    </section>

    <svg class="edges" :width="size.w" :height="size.h" aria-hidden="true">
      <defs>
        <marker id="arrow-manages" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" class="arrowhead" />
        </marker>
      </defs>
      <path v-for="l in lines" :key="l.key" :d="l.d" class="edge" :class="l.kind" :marker-end="l.kind === 'manages' ? 'url(#arrow-manages)' : undefined" />
    </svg>
  </div>
</template>
