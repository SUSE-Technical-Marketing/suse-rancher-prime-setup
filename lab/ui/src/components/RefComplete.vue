<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { accept, openRef, refTree, suggestions, type OpenRef, type Suggestion } from "../refs";
import { catalog, check, views } from "../store";

// Completes references while typing `{{ … }}` in any text box of the composer (form fields, lists,
// the YAML): one popup for the app, under the caret. ↑/↓ choose, Enter or Tab take, Esc closes.
type Editable = HTMLInputElement | HTMLTextAreaElement;

// The Lab document as the engine rendered it on the last check (chained vars filled in); as
// written until there is one.
const tree = computed(() => {
  const lab = views.value.find(v => v.kind === "Lab");
  return refTree(check.value?.lab ?? { name: lab?.metadata?.name, spec: lab?.spec }, catalog.value?.personal.secrets ?? []);
});

const el = ref<Editable>();
const open = ref<OpenRef>();
const items = ref<Suggestion[]>([]);
const active = ref(0);
const pos = ref({ x: 0, y: 0 });
const list = ref<HTMLElement>();

/** Kept on screen: moved left of the window's edge, or above the caret when there's no room below. */
async function fit(caret: { x: number; y: number }, lineHeight: number) {
  pos.value = caret;
  await nextTick();
  const r = list.value?.getBoundingClientRect();
  if (!r) return;
  pos.value = {
    x: Math.max(8, Math.min(caret.x, window.innerWidth - r.width - 8)),
    y: caret.y + r.height > window.innerHeight - 8 ? Math.max(8, caret.y - r.height - lineHeight - 4) : caret.y,
  };
}

const editable = (t: EventTarget | null): t is Editable =>
  t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && (t.type === "text" || t.type === "search"));

function close() {
  open.value = undefined;
  items.value = [];
  el.value = undefined;
}

/** Where the caret is on screen: the text up to it laid out in a copy of the box's styles. */
function caretPoint(box: Editable, at: number): { x: number; y: number } {
  const style = getComputedStyle(box);
  const mirror = document.createElement("div");
  for (const p of ["font", "letterSpacing", "padding", "border", "boxSizing", "lineHeight", "textIndent", "tabSize", "width"] as const) {
    (mirror.style as unknown as Record<string, string>)[p] = style[p] as string;
  }
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", top: "0", left: "0", overflow: "hidden",
    whiteSpace: box instanceof HTMLTextAreaElement ? "pre-wrap" : "pre", overflowWrap: "break-word",
  });
  mirror.textContent = box.value.slice(0, at);
  const mark = document.createElement("span");
  mark.textContent = "​";
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const r = box.getBoundingClientRect();
  const x = r.left + mark.offsetLeft - box.scrollLeft;
  const y = r.top + mark.offsetTop - box.scrollTop + mark.offsetHeight;
  mirror.remove();
  return { x: Math.min(x, r.right - 8), y: Math.min(y, r.bottom) + 2 };
}

function update(box: Editable) {
  const caret = box.selectionStart ?? box.value.length;
  const found = box.selectionEnd === caret ? openRef(box.value, caret) : undefined;
  const list = found ? suggestions(tree.value, found) : [];
  if (!found || list.length === 0) return close();
  el.value = box;
  open.value = found;
  items.value = list;
  active.value = Math.min(active.value, list.length - 1);
  void fit(caretPoint(box, found.start), parseFloat(getComputedStyle(box).lineHeight) || 18);
}

function take(s: Suggestion) {
  const box = el.value;
  const ref = open.value;
  if (!box || !ref) return;
  const caret = box.selectionStart ?? box.value.length;
  const r = accept(box.value, caret, ref, s);
  box.value = r.text;
  box.setSelectionRange(r.caret, r.caret);
  box.focus();
  // What a field listens to: v-model on `input`, the form's text fields on `change` (once it's whole).
  box.dispatchEvent(new Event("input", { bubbles: true }));
  if (r.done) {
    box.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  } else {
    active.value = 0;
    update(box);
  }
}

function onInput(e: Event) {
  if (editable(e.target)) update(e.target);
}
function onKey(e: KeyboardEvent) {
  if (!open.value || e.target !== el.value) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = items.value.length;
    active.value = (active.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
  } else if (e.key === "Enter" || e.key === "Tab") {
    take(items.value[active.value]);
  } else if (e.key === "Escape") {
    close();
  } else return;
  e.preventDefault();
  e.stopPropagation();
}
// Moving the caret elsewhere (a click, Home/End) closes it, or follows it into another `{{`.
function onSelect() {
  const box = document.activeElement;
  if (open.value && box === el.value && editable(box)) update(box);
}
function onFocusOut(e: FocusEvent) {
  if (e.target === el.value) close();
}

onMounted(() => {
  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("selectionchange", onSelect);
  document.addEventListener("focusout", onFocusOut, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("keydown", onKey, true);
  document.removeEventListener("selectionchange", onSelect);
  document.removeEventListener("focusout", onFocusOut, true);
});
</script>

<template>
  <ul v-if="open && items.length" ref="list" class="refs" role="listbox" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }" @mousedown.prevent>
    <li
      v-for="(s, i) in items" :key="s.name" role="option" :aria-selected="i === active" :class="{ active: i === active }"
      @mouseenter="active = i" @click="take(s)"
    >
      <span class="name">{{ s.name }}<span v-if="!s.node.leaf" class="more">.</span></span>
      <span v-if="s.node.detail" class="detail">{{ s.node.detail }}</span>
    </li>
    <li class="keys" aria-hidden="true">↑↓ choose · Enter take · Esc close</li>
  </ul>
</template>

<style scoped>
.refs {
  position: fixed; z-index: 50; margin: 0; padding: 4px 0; list-style: none; min-width: 220px; max-width: 420px;
  max-height: 260px; overflow-y: auto; background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 20px rgb(0 0 0 / .18); font-size: 13px;
}
.refs li { display: flex; gap: 12px; justify-content: space-between; padding: 4px 10px; cursor: pointer; }
.refs li.active { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.name { font-family: var(--mono); }
.more { opacity: .5; }
.detail { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.keys { color: var(--muted); font-size: 11px; cursor: default; border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; }
.refs li.keys { justify-content: flex-start; }
</style>
