<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { addBlock, addK3k, addNode, addProfile, defaultNetwork, removeProfile, runsKubernetes } from "../compose";
import { dragging, end, start, target, type Payload } from "../dnd";
import { catalog, file, problems, removeDoc, selected, views } from "../store";
import { kindOf, type Category } from "../kinds";
import KindIcon from "./KindIcon.vue";
import ProfileIcon from "./ProfileIcon.vue";

// The lab as a graph: a box per document, arrows for how they relate. Every document gets a box,
// whatever it refers to (a k3k cluster without a parent is a box without an arrow, and its
// problem badge). Click a box to edit it; drag it to move it; drop palette blocks on the canvas
// or on a box.

const emit = defineEmits<{ select: [index: number] }>();

// The first row leaves room for the lanes of arrows that run above the boxes.
const W = 184, H = 84, GAP_X = 52, GAP_Y = 30, PAD = 20, TOP = PAD + H + 32;
/** Profile tokens: docked on a host box's bottom edge, half outside it. */
const TOKEN = 26, TOKEN_GAP = 4;

type EdgeKind = "runs" | "manages" | "node" | "inside";
interface Box { index: number; key: string; kind: string; category?: Category; icon?: string; label: string; title: string; sub: string; chips: string[]; profiles: string[]; col: number; x: number; y: number }

const docs = computed(() => views.value.map((v, index) => ({ v, index })));
const name = (d: { v: { metadata?: { name?: string } } }) => d.v.metadata?.name ?? "";
const typeOf = (d: { v: { kind?: string; spec?: any } }) => (d.v.kind === "DownstreamCluster" ? d.v.spec?.type ?? "harvester" : undefined);
const defaults = computed(() => catalog.value?.defaults.vm);

/** Column: Harvesters and AWS sites, VMs and Machines, the clusters Rancher creates, k3k clusters; anything else below. */
function columnOf(d: { v: { kind?: string; spec?: any } }): number {
  switch (d.v.kind) {
    case "Harvester": case "AwsSite": return 0;
    case "HarvesterVM": case "Machine": return 1;
    case "DownstreamCluster": return typeOf(d) === "k3k" ? 3 : 2;
    default: return -1;
  }
}

function describe(d: { v: any; index: number }): Pick<Box, "label" | "title" | "sub" | "chips" | "profiles"> {
  const base = describeBox(d);
  const host = d.v.kind === "HarvesterVM" || d.v.kind === "Machine";
  return { ...base, chips: host ? [] : base.chips, profiles: host ? Object.keys(d.v.spec?.profiles ?? {}) : [] };
}

function describeBox(d: { v: any; index: number }): Pick<Box, "label" | "title" | "sub" | "chips"> {
  const s = d.v.spec ?? {};
  const title = name(d) || "(no name)";
  switch (d.v.kind) {
    case "Lab": return { label: "Lab", title, sub: `${s.domain ?? "no domain"} · TLS ${s.tls?.acme ?? "letsencrypt"}`, chips: [] };
    case "Harvester": return { label: "Harvester", title, sub: [`${(s.networks?.vlans ?? []).length} VLAN(s)`, s.dns?.host ? `DNS ${s.dns.host}` : ""].filter(Boolean).join(" · "), chips: [] };
    case "HarvesterVM": return {
      label: "VM", title, chips: Object.keys(s.profiles ?? {}),
      sub: `${s.os ?? "no OS"} · ${s.cpu ?? defaults.value?.cpu} CPU · ${s.memory ?? defaults.value?.memory} · ${s.network ?? defaultNetwork(s.harvester)}`,
    };
    case "Machine": return { label: "Machine", title, sub: `${s.address || "no address"} · ${s.os ?? "no OS"}`, chips: Object.keys(s.profiles ?? {}) };
    case "AwsSite": {
      const mine = catalog.value?.personal.awsSites.find(x => x.name === title);
      const aws = catalog.value?.defaults.aws;
      return {
        label: "AWS site", title, chips: s.ttl ? [`ttl ${s.ttl}`] : [],
        sub: `${s.region ?? mine?.region ?? "no region"} · zones ${(s.zones ?? aws?.zones ?? []).join(", ")} · ${s.vpc?.cidr ?? aws?.vpcCidr}`,
      };
    }
    case "DownstreamCluster": {
      const t = typeOf(d);
      if (t === "k3k") return { label: `k3k · ${s.mode ?? "shared"}`, title, sub: `${s.servers ?? 1} server · ${s.agents ?? 0} agents · ${s.namespace ?? `k3k-${title}`}`, chips: Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${v}`) };
      if (t === "custom") return { label: `custom · ${s.distro ?? "rke2"}`, title, sub: `${(s.nodes ?? []).length} node(s)`, chips: Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${v}`) };
      if (t === "ec2") return {
        label: `ec2 · ${s.distro ?? "rke2"}`, title, chips: Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${v}`),
        sub: ((s.pools ?? []) as any[]).map(p => `${p.quantity ?? 1}× ${p.instanceType ?? catalog.value?.defaults.aws.instanceType}`).join(", ") || "no pools",
      };
      if (t === "eks") return {
        label: `eks · ${s.version ?? catalog.value?.defaults.aws.eksVersion}`, title, chips: Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${v}`),
        sub: ((s.nodeGroups ?? []) as any[]).map(g => `${g.quantity ?? 1}× ${g.instanceType ?? catalog.value?.defaults.aws.instanceType}`).join(", ") || "no node groups",
      };
      const pools = (s.pools ?? []) as any[];
      return {
        label: `harvester · ${s.distro ?? "rke2"}`, title, chips: Object.entries(s.labels ?? {}).map(([k, v]) => `${k}=${v}`),
        sub: pools.map(p => `${p.quantity ?? 1}× ${p.cpu ?? defaults.value?.cpu} CPU · ${p.memory ?? defaults.value?.memory}`).join(", ") || "no pools",
      };
    }
    default: return { label: d.v.kind ?? "?", title, sub: "catalog override", chips: [] };
  }
}

// --- Positions: automatic, unless a box was moved (kept per lab, in this browser only) ---------
const storeKey = computed(() => `lab-ui:positions:${file.value || views.value.find(v => v.kind === "Lab")?.metadata?.name || "new"}`);
const moved = ref<Record<string, { x: number; y: number }>>({});
watch(storeKey, k => {
  try { moved.value = JSON.parse(localStorage.getItem(k) ?? "{}"); } catch { moved.value = {}; }
}, { immediate: true });
function remember() {
  try { localStorage.setItem(storeKey.value, JSON.stringify(moved.value)); } catch { /* positions are a convenience */ }
}

const boxes = computed<Box[]>(() => {
  const all = docs.value;
  const order = new Map<string, number>();
  const columns: { index: number; v: any }[][] = [[], [], [], []];
  for (const d of all) { const c = columnOf(d); if (c >= 0) columns[c].push(d); }
  // Keep related boxes level: VMs and clusters by where they run, k3k clusters by parent.
  const KIND_ORDER = ["Harvester", "AwsSite"];
  columns[0].sort((a, b) => KIND_ORDER.indexOf(a.v.kind) - KIND_ORDER.indexOf(b.v.kind));
  const homeRank = (s: any) => {
    const i = columns[0].findIndex(d => (d.v.kind === "Harvester" && name(d) === s?.harvester) || (d.v.kind === "AwsSite" && name(d) === s?.site));
    return i < 0 ? 99 : i;
  };
  columns[1].sort((a, b) => homeRank(a.v.spec) - homeRank(b.v.spec));
  columns[2].sort((a, b) => homeRank(a.v.spec) - homeRank(b.v.spec));
  columns[2].forEach((d, i) => order.set(name(d), i));
  columns[3].sort((a, b) => (order.get(a.v.spec?.parent) ?? 99) - (order.get(b.v.spec?.parent) ?? 99));

  const out: Box[] = [];
  const place = (d: { index: number; v: any }, col: number, x: number, y: number) => {
    const key = `${d.v.kind}/${name(d)}`;
    const at = moved.value[key] ?? { x, y };
    const k = kindOf(d.v.kind, typeOf(d));
    out.push({ index: d.index, key, kind: d.v.kind ?? "", category: k?.category, icon: k?.icon, col, ...describe(d), x: at.x, y: at.y } as Box);
  };
  const lab = all.find(d => d.v.kind === "Lab");
  if (lab) place(lab, -1, PAD, PAD);
  // Rows: a box goes no higher than what it runs on (its Harvester or site, a k3k cluster's
  // parent), so an arrow between them runs level instead of across other boxes.
  const rowOf = new Map<string, number>();
  const anchor = (d: { v: any }, c: number) => {
    const s = d.v.spec ?? {};
    if (c === 3) return rowOf.get(`2/${s.parent}`) ?? 0;
    if (c === 1 || c === 2) return rowOf.get(`0/${s.harvester ?? s.site}`) ?? 0;
    return 0;
  };
  let bottom = TOP;
  columns.forEach((col, c) => {
    let next = 0;
    for (const d of col) {
      const row = Math.max(next, anchor(d, c));
      rowOf.set(`${c}/${name(d)}`, row);
      next = row + 1;
      const y = TOP + row * (H + GAP_Y);
      place(d, c, PAD + c * (W + GAP_X), y);
      bottom = Math.max(bottom, y + H + GAP_Y);
    }
  });
  all.filter(d => columnOf(d) < 0 && d.v.kind !== "Lab").forEach((d, i) => place(d, -1, PAD + i * (W + GAP_Y), bottom + 24));
  return out;
});
const byIndex = computed(() => new Map(boxes.value.map(b => [b.index, b])));
const size = computed(() => ({
  w: Math.max(...boxes.value.map(b => b.x + W), PAD + 4 * (W + GAP_X)) + PAD,
  h: Math.max(...boxes.value.map(b => b.y + H), TOP + H) + PAD,
}));

// --- Arrows ------------------------------------------------------------------------------------
const edges = computed(() => {
  const find = (kinds: string[], n?: string) => docs.value.find(d => kinds.includes(d.v.kind ?? "") && name(d) === n)?.index;
  const out: { from: number; to: number; kind: EdgeKind }[] = [];
  for (const d of docs.value) {
    const s = d.v.spec ?? {};
    const add = (to: number | undefined, kind: EdgeKind) => { if (to !== undefined) out.push({ from: d.index, to, kind }); };
    if (d.v.kind === "HarvesterVM") add(find(["Harvester"], s.harvester), "runs");
    if (d.v.kind !== "DownstreamCluster") continue;
    const t = typeOf(d);
    // Every cluster, k3k ones too, is managed by its Rancher.
    const rancher = find(["HarvesterVM", "Machine"], s.rancher);
    if (rancher !== undefined) out.push({ from: rancher, to: d.index, kind: "manages" });
    if (t === "k3k") { add(find(["DownstreamCluster"], s.parent), "inside"); continue; }
    if (t === "harvester") add(find(["Harvester"], s.harvester), "runs");
    if (t === "ec2" || t === "eks") add(find(["AwsSite"], s.site), "runs");
    if (t === "custom") for (const n of (s.nodes ?? []) as { host?: string }[]) add(find(["HarvesterVM", "Machine"], n.host), "node");
  }
  return out;
});

/**
 * A curve between two boxes, leaving and entering on the sides that face each other. Between boxes
 * a column or more apart (a Rancher VM and its k3k clusters) it leaves from the top, runs above
 * the boxes in between, and comes down the gap beside the target's column into its side: never
 * through another box, nor down past the boxes above the target.
 */
/** How far above the boxes each kind of arrow runs when it goes over them: a lane each, so they don't overlap. */
const LANE: Record<EdgeKind, number> = { runs: 8, manages: 18, node: 13, inside: 23 };

function path(a: Box, b: Box, kind: EdgeKind): string {
  if (Math.abs(b.x - a.x) > 1.5 * (W + GAP_X)) {
    const right = b.x > a.x;
    const x1 = a.x + (right ? (2 * W) / 3 : W / 3);
    const gap = right ? b.x - GAP_X / 2 : b.x + W + GAP_X / 2;
    const top = Math.min(a.y, b.y) - LANE[kind], r = 10;
    // Above the target's middle, so it doesn't meet the arrows that leave from there.
    const y2 = b.y + H / 3, x2 = right ? b.x - 6 : b.x + W + 6;
    const turn = right ? r : -r;
    return `M ${x1} ${a.y} C ${x1} ${top}, ${x1} ${top}, ${x1 + turn * 2} ${top} L ${gap - turn} ${top} Q ${gap} ${top}, ${gap} ${top + r} L ${gap} ${y2 - r} Q ${gap} ${y2}, ${gap + turn} ${y2} L ${x2} ${y2}`;
  }
  const sameColumn = Math.abs(a.x - b.x) < W / 2;
  if (sameColumn) {
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x + W, y2 = b.y + H / 2, bend = 48 + Math.abs(y2 - y1) / 6;
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 + bend} ${y2}, ${x2 + 6} ${y2}`;
  }
  const leftToRight = a.x < b.x;
  const x1 = leftToRight ? a.x + W : a.x, y1 = a.y + H / 2;
  const x2 = leftToRight ? b.x - 6 : b.x + W + 6, y2 = b.y + H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (leftToRight ? 1 : -1);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
const lines = computed(() => edges.value.flatMap(e => {
  const a = byIndex.value.get(e.from), b = byIndex.value.get(e.to);
  return a && b ? [{ key: `${e.from}-${e.to}-${e.kind}`, d: path(a, b, e.kind), kind: e.kind, active: selected.value === e.from || selected.value === e.to }] : [];
}));

// --- Zoom: fits the pane's width by default (not below 80%, so text stays readable) --------------
const scroller = ref<HTMLElement>();
const paneWidth = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([e]) => (paneWidth.value = e.contentRect.width));
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
const zoom = ref<number>();
const fit = computed(() => (paneWidth.value ? Math.max(0.8, Math.min(1, (paneWidth.value - 4) / size.value.w)) : 1));
const scale = computed(() => zoom.value ?? fit.value);
const zoomBy = (f: number) => (zoom.value = Math.min(1.5, Math.max(0.4, Math.round(scale.value * f * 100) / 100)));

// --- Moving boxes, selecting ---------------------------------------------------------------------
let drag: { key: string; dx: number; dy: number; startX: number; startY: number; moving: boolean } | undefined;
function down(e: PointerEvent, b: Box) {
  if (e.button !== 0) return;
  drag = { key: b.key, dx: e.clientX / scale.value - b.x, dy: e.clientY / scale.value - b.y, startX: e.clientX, startY: e.clientY, moving: false };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  if (!drag) return;
  if (!drag.moving && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
  drag.moving = true;
  moved.value = { ...moved.value, [drag.key]: { x: Math.max(0, e.clientX / scale.value - drag.dx), y: Math.max(0, e.clientY / scale.value - drag.dy) } };
}
function up(b: Box) {
  if (drag && !drag.moving) emit("select", b.index);
  else if (drag) remember();
  drag = undefined;
}
function tidy() {
  moved.value = {};
  remember();
}
function onKey(e: KeyboardEvent, b: Box) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); emit("select", b.index); }
  if ((e.key === "Delete" || e.key === "Backspace") && b.kind !== "Lab" && confirm(`Remove ${b.kind} ${b.title} from the lab?`)) removeDoc(b.index);
}

// --- Dropping palette blocks and profiles ----------------------------------------------------------
const over = ref<number | "canvas">();
const accepts = (b: Box, p: Payload) => {
  if (p.type === "profile") return (b.kind === "HarvesterVM" || b.kind === "Machine") && p.from !== b.index && !b.profiles.includes(p.name);
  if (p.type === "block") {
    if (b.kind === "Harvester") return ["HarvesterVM", "RancherVM", "DownstreamCluster"].includes(p.block);
    if (b.kind === "AwsSite") return p.block === "Ec2Cluster" || p.block === "EksCluster";
    if (b.kind === "DownstreamCluster") return p.block === "K3kCluster" && !b.label.startsWith("k3k");
  }
  if (p.type === "host") return b.label.startsWith("custom") && !runsKubernetes(p.index);
  return false;
};
const dropOn = (b: Box) => target(p => accepts(b, p), p => {
  if (p.type === "profile") { addProfile(b.index, p.name); if (p.from !== undefined) removeProfile(p.from, p.name); }
  else if (p.type === "block" && b.kind === "Harvester") addBlock(p.block, b.title, defaultNetwork(b.title));
  else if (p.type === "block" && b.kind === "AwsSite") addBlock(p.block, b.title);
  else if (p.type === "block") addK3k(b.title);
  else if (p.type === "host") addNode(b.index, views.value[p.index]?.metadata?.name ?? "");
}, on => (over.value = on ? b.index : undefined));
const onCanvas = target(p => p.type === "block", p => { if (p.type === "block") addBlock(p.block); }, on => (over.value = on ? "canvas" : undefined));
const wants = (b: Box) => !!dragging.value && accepts(b, dragging.value);
const badge = (i: number) => problems.value[i];
const profileInfo = (name: string) => catalog.value?.profiles.find(p => p.name === name)?.description ?? "not in the catalog";
</script>

<template>
  <div class="graph" :class="{ over: over === 'canvas' }" v-on="onCanvas">
    <div class="graph-bar">
      <span class="g-legend" aria-hidden="true">
        <span><svg width="26" height="8"><path d="M0 4 H22" class="edge runs" marker-end="url(#g-arrow)" /></svg> runs on</span>
        <span><svg width="26" height="8"><path d="M0 4 H22" class="edge manages" marker-end="url(#g-arrow)" /></svg> manages</span>
        <span><svg width="26" height="8"><path d="M0 4 H22" class="edge node" marker-end="url(#g-arrow)" /></svg> node</span>
        <span><svg width="26" height="8"><path d="M0 4 H22" class="edge inside" marker-end="url(#g-arrow)" /></svg> inside</span>
      </span>
      <span class="g-tools">
        <button type="button" class="icon-btn" title="Zoom out" aria-label="Zoom out" @click="zoomBy(1 / 1.2)">−</button>
        <button type="button" class="link" title="Fit the pane's width" @click="zoom = undefined">{{ Math.round(scale * 100) }}%</button>
        <button type="button" class="icon-btn" title="Zoom in" aria-label="Zoom in" @click="zoomBy(1.2)">+</button>
        <button type="button" class="link" title="Put every box back in its column" @click="tidy">Tidy up</button>
      </span>
    </div>
    <div ref="scroller" class="graph-scroll">
      <div class="graph-fit" :style="{ width: `${size.w * scale}px`, height: `${size.h * scale}px` }">
      <div class="graph-area" :style="{ width: `${size.w}px`, height: `${size.h}px`, transform: `scale(${scale})` }">
        <svg class="graph-edges" :width="size.w" :height="size.h" aria-hidden="true">
          <defs>
            <marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" class="arrowhead" />
            </marker>
          </defs>
          <path v-for="l in lines" :key="l.key" :d="l.d" class="edge" :class="[l.kind, { active: l.active }]" marker-end="url(#g-arrow)" />
        </svg>
        <article
          v-for="b in boxes" :key="b.index"
          class="gbox" :class="[`k-${b.kind}`, b.category && `cat-${b.category}`, { active: selected === b.index, over: over === b.index, wants: wants(b) }]"
          :style="{ left: `${b.x}px`, top: `${b.y}px`, width: `${W}px`, height: `${H}px` }"
          tabindex="0" :aria-label="`${b.kind} ${b.title}`"
          @pointerdown="down($event, b)" @pointermove="move" @pointerup="up(b)" @keydown="onKey($event, b)"
          v-on="dropOn(b)"
        >
          <header>
            <span class="glabel"><KindIcon v-if="b.icon" :icon="b.icon" :size="13" />{{ b.label }}</span>
            <span v-if="badge(b.index)?.errors" class="badge bad" :title="`${badge(b.index).errors} error(s)`">{{ badge(b.index).errors }}</span>
            <span v-else-if="badge(b.index)?.warnings" class="badge warn" :title="`${badge(b.index).warnings} warning(s)`">{{ badge(b.index).warnings }}</span>
          </header>
          <strong class="gtitle">{{ b.title }}</strong>
          <span class="gsub">{{ b.sub }}</span>
          <span v-if="b.chips.length" class="gchips">
            <span v-for="c in b.chips" :key="c" class="gchip" :title="c">{{ c }}</span>
          </span>
          <span v-else-if="b.profiles.length === 0 && (b.kind === 'HarvesterVM' || b.kind === 'Machine')" class="gsub hint">drop profiles here</span>
        </article>
        <template v-for="b in boxes" :key="`p-${b.index}`">
          <span
            v-for="(p, i) in b.profiles" :key="p" class="gtoken" draggable="true"
            :style="{ left: `${b.x + 10 + i * (TOKEN + TOKEN_GAP)}px`, top: `${b.y + H - TOKEN / 2}px` }"
            :title="`${p}: ${profileInfo(p)}\ndrag to another host, or back to the palette to remove`"
            @dragstart="start($event, { type: 'profile', name: p, from: b.index })" @dragend="end"
            @click="emit('select', b.index)"
          ><ProfileIcon :name="p" :size="TOKEN" /></span>
        </template>
        <p v-if="boxes.length <= 1" class="graph-empty" :style="{ top: `${TOP}px`, left: `${PAD}px` }">Drag a Harvester or a Machine here to start.</p>
      </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.graph.over .graph-area { outline: 2px dashed var(--accent); outline-offset: -6px; }
.graph-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 0 0 8px; font-size: 12px; color: var(--muted); }
.g-tools { display: inline-flex; align-items: center; gap: 8px; }
.icon-btn { padding: 0 8px; line-height: 1.4; }
.g-legend { display: flex; flex-direction: row; gap: 14px; flex-wrap: wrap; }
.g-legend span { display: inline-flex; align-items: center; gap: 4px; }
.graph-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.graph-area { position: relative; transform-origin: 0 0; }
.graph-edges { position: absolute; inset: 0; pointer-events: none; }
.edge { fill: none; stroke-width: 1.6; stroke: var(--muted); opacity: 0.55; }
.edge.active { opacity: 1; stroke-width: 2.2; }
.edge.runs { stroke: var(--muted); }
.edge.manages { stroke: #2f6fdb; stroke-dasharray: 6 4; }
.edge.node { stroke: var(--accent); }
.edge.inside { stroke: #8a5cd6; stroke-dasharray: 2 3; }
.arrowhead { fill: var(--muted); }
.gbox {
  position: absolute; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
  cursor: grab; user-select: none; touch-action: none; overflow: hidden; box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
}
.gbox:active { cursor: grabbing; }
.gbox.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.gbox.wants { border-style: dashed; border-color: var(--accent); }
.gbox.over { background: var(--ok-bg); }
.gbox header { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.glabel { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--cat, var(--accent)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Each category its color and shape (style.css): infrastructure a square box with a tinted header
   band, machines rounded, clusters round with a doubled edge. */
.gbox[class*="cat-"] { border-left: 4px solid var(--cat); border-radius: var(--cat-radius); }
.cat-infra.gbox { background: linear-gradient(color-mix(in srgb, var(--cat) 14%, var(--panel)) 0 26px, var(--panel) 26px); }
.cat-cluster.gbox, .cat-virtual.gbox { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cat) 35%, transparent), 0 1px 2px rgb(0 0 0 / 6%); }
.cat-virtual.gbox { border-style: solid dashed dashed solid; border-color: color-mix(in srgb, var(--cat) 50%, var(--border)); border-left-color: var(--cat); }
.gbox.cat-infra.active, .gbox.cat-machine.active, .gbox.cat-cluster.active, .gbox.cat-virtual.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.gtitle { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gsub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gchips { display: flex; gap: 4px; overflow: hidden; white-space: nowrap; mask-image: linear-gradient(to right, black 85%, transparent); }
.gchip { font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); cursor: grab; }
.graph-empty { position: absolute; margin: 0; color: var(--muted); }
.gtoken { position: absolute; z-index: 1; display: inline-flex; border-radius: 50%; cursor: grab; box-shadow: 0 0 0 2px var(--panel-2); }
.gtoken:hover { transform: scale(1.12); }
.hint { font-style: italic; }
@media (prefers-color-scheme: dark) {
  .edge.manages { stroke: #6f9eef; }
  .edge.inside { stroke: #b08cf0; }
}
</style>
