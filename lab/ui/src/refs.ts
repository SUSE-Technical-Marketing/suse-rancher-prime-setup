// Completing references in templates as you type (DESIGN.md §5.1): after `{{`, the names a lab file
// can use, `lab.*` (the Lab document, and its name) and `secrets.*` (the personal config's secrets,
// by name and shape, never their values). The engine still checks what's written.

/** One name in the tree of what a template can refer to. */
export interface RefNode {
    /** What it is, shown next to it: a lab value, a secret's shape. */
    detail?: string;
    children?: Record<string, RefNode>;
    /** Usable as it is (a value, a whole secret); otherwise only a way to what's under it. */
    leaf: boolean;
}

/** The tree for a Lab document and the personal config's secrets (their paths and shapes). */
export function refTree(lab: { name?: string; spec?: unknown } | undefined, secrets: { path: string[]; shape: string; fields?: string[] }[]): Record<string, RefNode> {
    const fromValue = (v: unknown): RefNode => {
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            return { leaf: false, children: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromValue(x)])) };
        }
        return { leaf: true, detail: Array.isArray(v) ? `[${v.length} items]` : String(v) };
    };
    const spec = typeof lab?.spec === "object" && lab.spec !== null && !Array.isArray(lab.spec) ? (lab.spec as Record<string, unknown>) : {};
    const labNode = fromValue({ name: lab?.name ?? "", ...spec });

    const secretsNode: RefNode = { leaf: false, children: {} };
    for (const s of secrets) {
        let node = secretsNode;
        for (const key of s.path) {
            node.children ??= {};
            node = node.children[key] ??= { leaf: false };
        }
        // A map is a way to its fields; a string or credentials is used as it is.
        node.leaf = s.shape !== "map";
        node.detail = s.shape === "map" ? `fields: ${(s.fields ?? []).join(", ")}` : s.shape;
        for (const f of s.shape === "map" ? s.fields ?? [] : []) {
            node.children ??= {};
            node.children[f] ??= { leaf: true };
        }
    }
    return { lab: { ...labNode, detail: "the Lab document" }, secrets: { ...secretsNode, detail: "the personal config's secrets" } };
}

/** A path as a template writes it: `secrets['ssh-key']` for a name that isn't an identifier. */
export const formatPath = (path: string[]) =>
    path.map((k, i) => (/^[A-Za-z_]\w*$/.test(k) ? `${i === 0 ? "" : "."}${k}` : `['${k.replace(/'/g, "\\'")}']`)).join("");

/** An open `{{ … ` the caret is in: where its expression starts, and the path typed so far. */
export interface OpenRef {
    /** Where the expression starts (after `{{` and its spaces). */
    start: number;
    /** Whether a space follows `{{`. */
    spaced: boolean;
    /** The names typed, complete ones first, then the partial last one (maybe ""). */
    path: string[];
    partial: string;
}

/** The reference the caret is in, if it's in an open `{{` (no `}}` since) and only a path so far. */
export function openRef(text: string, caret: number): OpenRef | undefined {
    const before = text.slice(0, caret);
    const open = before.lastIndexOf("{{");
    if (open < 0 || before.indexOf("}}", open) >= 0) return undefined;
    const rest = before.slice(open + 2).replace(/^-/, "");
    const lead = /^\s*/.exec(rest)![0];
    const expr = rest.slice(lead.length);
    const start = caret - expr.length;
    const segments: string[] = [];
    let i = 0;
    for (;;) {
        const name = /^[A-Za-z_]\w*/.exec(expr.slice(i));
        const bracket = /^\[\s*(['"])(.*?)\1\s*\]/.exec(expr.slice(i));
        if (name && i === 0) { segments.push(name[0]); i += name[0].length; }
        else if (expr[i] === "." ) {
            const n = /^[A-Za-z_]\w*/.exec(expr.slice(i + 1));
            if (!n) { if (i + 1 === expr.length) { segments.push(""); i += 1; } break; }
            segments.push(n[0]); i += 1 + n[0].length;
        } else if (bracket) { segments.push(bracket[2]); i += bracket[0].length; }
        else break;
        if (i >= expr.length) break;
    }
    // Something other than a path (a filter, an operator): nothing to complete.
    if (i !== expr.length) return undefined;
    if (segments.length === 0) return { start, spaced: lead.length > 0, path: [], partial: "" };
    // Ending on a "." or on a complete bracket: the partial name is empty.
    const ended = expr.endsWith(".") || expr.endsWith("]");
    return ended
        ? { start, spaced: lead.length > 0, path: segments.filter((_, k) => !(expr.endsWith(".") && k === segments.length - 1)), partial: "" }
        : { start, spaced: lead.length > 0, path: segments.slice(0, -1), partial: segments[segments.length - 1] };
}

export interface Suggestion { name: string; path: string[]; node: RefNode }

/** What can come next at an open reference, those starting with what's typed first. */
export function suggestions(tree: Record<string, RefNode>, ref: OpenRef): Suggestion[] {
    let level: Record<string, RefNode> | undefined = tree;
    for (const key of ref.path) level = level?.[key]?.children;
    if (!level) return [];
    const p = ref.partial.toLowerCase();
    const names = Object.keys(level).filter(n => n.toLowerCase().includes(p));
    names.sort((a, b) => Number(!a.toLowerCase().startsWith(p)) - Number(!b.toLowerCase().startsWith(p)) || a.localeCompare(b));
    return names.map(name => ({ name, path: [...ref.path, name], node: level![name] }));
}

/**
 * The text with a suggestion taken: the path written out, and either `.` to go on (a name with
 * nothing usable of its own) or the template closed with ` }}` (unless it already is). Returns the
 * new text, where the caret goes, and whether the reference is complete.
 */
export function accept(text: string, caret: number, ref: OpenRef, s: Suggestion): { text: string; caret: number; done: boolean } {
    const done = s.node.leaf || !s.node.children;
    const after = text.slice(caret).replace(/^[\w'"\]\[.]*/, "");
    const closed = /^\s*-?\}\}/.test(after);
    const insert = `${ref.spaced ? "" : " "}${formatPath(s.path)}${done ? (closed ? "" : " }}") : "."}`;
    const head = text.slice(0, ref.start) + insert;
    const caretAt = done && closed ? head.length + /^\s*-?\}\}/.exec(after)![0].length : head.length;
    return { text: head + after, caret: caretAt, done };
}
