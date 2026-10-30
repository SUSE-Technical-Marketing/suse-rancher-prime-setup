// The lab being edited: its documents as `yaml` Documents, so a form changing one value leaves the
// rest of the file (comments, flow style, order) as it was. Components read plain-object views and
// change the documents through set / append / remove, by path.

import { computed, markRaw, ref, shallowRef } from "vue";
import { Document, parseAllDocuments } from "yaml";
import type { Catalog, CheckResult } from "./api";

export const API_VERSION = "lab.geeko.me/v1alpha1";
export type Path = (string | number)[];

/** A document as a plain object. */
export interface LabDoc {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; description?: string; [k: string]: unknown };
    spec?: any;
}

const docs = shallowRef<Document[]>([]);
/** Bumped on every change: the views and the text follow it. */
const version = ref(0);

export const file = ref("");
export const dirty = ref(false);
export const selected = ref(0);
/** Whether the selected document's form is open (the drawer over the side pane). */
export const drawer = ref(false);
/** The drawer's tab: the document's form, or its YAML. */
export const drawerTab = ref<"form" | "yaml">("form");
/** The side pane's tab, under the drawer. */
export const sideTab = ref<"yaml" | "plan" | "problems">("yaml");
export const parseError = ref("");
export const catalog = shallowRef<Catalog>();
export const check = shallowRef<CheckResult>();

export const views = computed<LabDoc[]>(() => {
    void version.value;
    return docs.value.map(d => (d.toJS() ?? {}) as LabDoc);
});

export const text = computed(() => {
    void version.value;
    return docs.value.map((d, i) => {
        d.directives!.docStart = i > 0 ? true : null;
        return d.toString({ lineWidth: 0 });
    }).join("");
});

function changed() {
    version.value++;
    dirty.value = true;
}

function parse(source: string): Document[] | string {
    const parsed = parseAllDocuments(source);
    if (!Array.isArray(parsed)) return "not a YAML stream";
    const problem = parsed.flatMap(d => d.errors)[0];
    if (problem) return problem.message;
    return parsed.filter(d => d.contents !== null).map(d => markRaw(d as Document));
}

/** Open a lab file's text (or a new lab's). */
export function load(source: string, name: string): string | undefined {
    const parsed = parse(source);
    if (typeof parsed === "string") return parsed;
    docs.value = parsed;
    file.value = name;
    selected.value = 0;
    parseError.value = "";
    version.value++;
    dirty.value = false;
    return undefined;
}

/** The YAML pane's text, edited by hand: applied when it parses. */
export function setText(source: string) {
    const parsed = parse(source);
    if (typeof parsed === "string") {
        parseError.value = parsed;
        return;
    }
    parseError.value = "";
    docs.value = parsed;
    if (selected.value >= parsed.length) selected.value = Math.max(0, parsed.length - 1);
    changed();
}

/** One document's text, for its own YAML tab. */
export function docText(index: number): string {
    void version.value;
    const d = docs.value[index];
    if (!d) return "";
    d.directives!.docStart = null;
    const out = d.toString({ lineWidth: 0 });
    d.directives!.docStart = index > 0 ? true : null;
    return out;
}

/** One document's YAML tab, edited by hand: applied when it parses as one document; else what's wrong. */
export function setDocText(index: number, source: string): string | undefined {
    const parsed = parse(source);
    if (typeof parsed === "string") return parsed;
    if (parsed.length !== 1) return "one document here: add others from the palette or in the lab's YAML";
    if (!docs.value[index]) return undefined;
    docs.value = docs.value.map((d, i) => (i === index ? parsed[0] : d));
    changed();
    return undefined;
}

const node = (d: Document, value: unknown) => (typeof value === "object" && value !== null ? d.createNode(value) : value);

/** Set a value; `undefined` or "" removes the key, so cleared fields don't stay as empty strings. */
export function set(index: number, path: Path, value: unknown) {
    const d = docs.value[index];
    if (!d) return;
    if (value === undefined || value === "") {
        if (d.hasIn(path)) d.deleteIn(path);
    } else {
        d.setIn(path, node(d, value));
    }
    changed();
}

/** Add to the list at `path` (created when missing). */
export function append(index: number, path: Path, value: unknown) {
    const d = docs.value[index];
    if (!d) return;
    if (d.hasIn(path)) d.addIn(path, node(d, value));
    else d.setIn(path, d.createNode([value]));
    changed();
}

export function remove(index: number, path: Path) {
    docs.value[index]?.deleteIn(path);
    changed();
}

export function addDoc(kind: string, name: string, spec: Record<string, unknown>) {
    const d = new Document({ apiVersion: API_VERSION, kind, metadata: { name }, spec });
    docs.value = [...docs.value, markRaw(d)];
    selected.value = docs.value.length - 1;
    changed();
}

export function removeDoc(index: number) {
    docs.value = docs.value.filter((_, i) => i !== index);
    if (selected.value >= docs.value.length) selected.value = Math.max(0, docs.value.length - 1);
    changed();
}

/** The Cloudflare token among the personal config's secrets: `cloudflare.token` unless only another is there. */
function cloudflareSecret(): string {
    const strings = (catalog.value?.personal.secrets ?? []).filter(s => s.shape === "string");
    const found = ["cloudflare.token", "cloudflare-token", "cloudflare"].find(n => strings.some(s => s.name === n)) ?? "cloudflare.token";
    return found === "cloudflare-token" ? "{{ secrets['cloudflare-token'] }}" : `{{ secrets.${found} }}`;
}

/** A new lab: just its Lab document, with the team's usual settings. */
export function newLabText(name: string): string {
    return new Document({
        apiVersion: API_VERSION,
        kind: "Lab",
        metadata: { name },
        spec: {
            domain: "lab.geeko.me",
            tls: { acme: "letsencrypt-staging", cloudflare: cloudflareSecret() },
            ssh: { publicKey: { file: "~/.ssh/id_ed25519.pub" }, privateKey: "{{ secrets['ssh-key'] }}" },
        },
    }).toString();
}

/** A name that no document of that kind has yet: `vm`, `vm-2`, ... */
export function freeName(kind: string, base: string): string {
    const taken = new Set(views.value.filter(v => v.kind === kind).map(v => v.metadata?.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Which document a diagnostic is about: `Kind/name.spec...`, or the Lab document. */
export function docOf(path: string): { index: number; field: string } {
    const m = /^([A-Za-z]+)\/([^.]+)\.?(.*)$/.exec(path);
    if (m) {
        const index = views.value.findIndex(v => v.kind === m[1] && v.metadata?.name === m[2]);
        if (index >= 0) return { index, field: m[3] };
    }
    return { index: views.value.findIndex(v => v.kind === "Lab"), field: path };
}

/** `a.b.0.c` -> ["a", "b", 0, "c"] */
export const toPath = (dotted: string): Path => dotted.split(".").map(p => (/^\d+$/.test(p) ? Number(p) : p));

export function get(obj: unknown, path: Path): any {
    let cur: any = obj;
    for (const p of path) cur = cur?.[p];
    return cur;
}

/** Errors and warnings per document index, for badges. */
export const problems = computed(() => {
    const count: Record<number, { errors: number; warnings: number }> = {};
    for (const d of check.value?.diagnostics ?? []) {
        const { index } = docOf(d.path);
        const c = (count[index] ??= { errors: 0, warnings: 0 });
        if (d.level === "error") c.errors++;
        else c.warnings++;
    }
    return count;
});
