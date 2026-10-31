import * as nunjucks from "nunjucks";
import { isTemplate, renderTemplate } from "./templates";
import { usesSecrets } from "./secrets";

// References to the lab in a lab file's own documents (DESIGN.md §5.1): `lab` is the Lab document's
// spec with its `name`, as in profile templates, so `{{ lab.domain }}`, `{{ lab.name }}`,
// `{{ lab.tls.email }}`, in any string of the Lab document and of its Harvesters, AWS sites, hosts
// and clusters, e.g. `hosted-domain: "{{ lab.domain }}"`. They're rendered when the file loads,
// before its documents are checked, so `address: "nuc.{{ lab.domain }}"` is checked as the name it
// gives. A reference to anything the Lab document doesn't have is an error at the value's path,
// never left in the lab as text. The Lab document's own values can refer to each other, at any
// depth (`b: "{{ lab.vars.a }}-y"`, `c: "{{ lab.vars.b }}-z"`); a circle is an error. Secrets are
// left for later (§10): in a value that uses them, the `{{ … }}` blocks with `secrets` stay as
// written, to be rendered with the secrets' values; the rest is filled in.

/** What a lab file's templates see as `lab`. */
export type LabRefs = Record<string, unknown>;

/**
 * A Lab document value still to be filled in, while the Lab document is being rendered: where it is
 * (`lab.vars.b`) and its template (none for a missing name).
 */
class Pending {
    constructor(readonly path: string, readonly template?: string) {}
}

/** A template that still refers to the lab: one that only uses secrets is done (it's left for later). */
function refersToLab(template: string): boolean {
    try {
        return referencesOf(template).some(r => r[0] !== "secrets");
    } catch {
        return true; // a syntax error: rendering it reports that
    }
}

/**
 * `lab` for rendering the Lab document itself: its values so far, the ones that still refer to
 * the lab marked, so `email: "admin@{{ lab.domain }}"` works and a reference to one waits for it.
 */
export function labRefsOf(main: { name?: unknown; spec?: unknown }): LabRefs {
    const mark = (v: unknown, at: string): unknown => {
        if (typeof v === "string") return isTemplate(v) && refersToLab(v) ? new Pending(at, v) : v;
        if (Array.isArray(v)) return v.map((x, i) => mark(x, `${at}[${i}]`));
        if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mark(x, `${at}.${k}`)]));
        return v;
    };
    const spec = typeof main.spec === "object" && main.spec !== null && !Array.isArray(main.spec) ? main.spec as Record<string, unknown> : {};
    return { ...(mark(spec, "lab") as Record<string, unknown>), name: typeof main.name === "string" ? main.name : new Pending("lab.name") };
}

/** `lab` for the lab's other documents: the Lab document rendered (defaults applied), with its name. */
export const labRefsFrom = (name: string, spec: Record<string, unknown>): LabRefs => ({ ...spec, name });

/** Functions the template engine has itself. */
const GLOBALS = new Set(["range", "cycler", "joiner"]);

interface TemplateNode { typename: string; fields?: string[]; value?: unknown; [field: string]: unknown }
/** Nunjucks' parser: exported, but not in its type definitions. */
const parser = (nunjucks as unknown as { parser: { parse(src: string): TemplateNode } }).parser;

/**
 * The references a template makes, as paths (`["lab", "tls", "email"]`, `["domain"]`): read from
 * its syntax tree, so one under a `default` filter or in a branch not taken counts too. Names the
 * template defines itself (`{% for x in … %}`, `{% set … %}`) aren't references.
 */
function referencesOf(template: string): string[][] {
    const root = parser.parse(template);
    const refs: string[][] = [];
    const locals = new Set<string>();
    const children = (node: TemplateNode, skip: string[] = []) =>
        (node.fields ?? []).filter(f => !skip.includes(f)).flatMap(f => (Array.isArray(node[f]) ? node[f] as TemplateNode[] : [node[f] as TemplateNode]))
            .filter(c => c && typeof c === "object" && typeof c.typename === "string");
    const walk = (node: TemplateNode): void => {
        switch (node.typename) {
            case "Symbol":
                refs.push([String(node.value)]);
                return;
            case "LookupVal": {
                // lab.tls.email: Symbol lab, then the literal keys; a computed key ends the path.
                const keys: string[] = [];
                let at: TemplateNode = node;
                while (at.typename === "LookupVal") {
                    const val = at.val as TemplateNode;
                    if (val.typename === "Literal") keys.unshift(String(val.value));
                    else { keys.length = 0; walk(val); }
                    at = at.target as TemplateNode;
                }
                if (at.typename === "Symbol") refs.push([String(at.value), ...keys]);
                else walk(at);
                return;
            }
            case "Filter":
                children(node, ["name"]).forEach(walk);
                return;
            case "FunCall":
                if ((node.name as TemplateNode).typename === "Symbol" && GLOBALS.has(String((node.name as TemplateNode).value))) {
                    children(node, ["name"]).forEach(walk);
                    return;
                }
                break;
            case "For":
            case "Set":
                for (const t of [node.name, ...(Array.isArray(node.targets) ? node.targets : [])] as TemplateNode[]) {
                    if (t?.typename === "Symbol") locals.add(String(t.value));
                    if (t?.typename === "Array") (t.children as TemplateNode[]).forEach(c => c.typename === "Symbol" && locals.add(String(c.value)));
                }
                children(node, ["name", "targets"]).forEach(walk);
                return;
        }
        children(node).forEach(walk);
    };
    walk(root);
    return refs.filter(r => !locals.has(r[0]));
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysOf = (v: Record<string, unknown>, at: string) => Object.keys(v).sort().map(k => `${at}.${k}`).join(", ");

/** The Pending values under a value (itself, or in the map or list it is). */
const pendingIn = (v: unknown): Pending[] =>
    v instanceof Pending ? [v] : Array.isArray(v) ? v.flatMap(pendingIn) : isMap(v) ? Object.values(v).flatMap(pendingIn) : [];

/**
 * A template's references to the lab: what's wrong with them (`problem`), or the values still to be
 * filled in that it has to wait for (`waits`).
 */
function referenceCheck(template: string, refs: LabRefs): { problem?: string; waits: Pending[] } {
    const waits: Pending[] = [];
    for (const path of referencesOf(template)) {
        const ref = path.join(".");
        if (path[0] === "secrets") continue;
        if (path[0] !== "lab") return { problem: `unknown reference "${ref}"; a lab file's templates can use lab (the Lab document: ${keysOf(refs, "lab")}) and secrets`, waits };
        // Down the Lab document's maps and lists; a key past a string or number is that value's own (lab.domain.length).
        let value: unknown = refs;
        for (let i = 1; i < path.length && !(value instanceof Pending); i++) {
            const at = path.slice(0, i).join(".");
            if (Array.isArray(value)) {
                if (!/^\d+$/.test(path[i]) || Number(path[i]) >= value.length) return { problem: `unknown reference "${ref}"; ${at} is a list of ${value.length}`, waits };
                value = value[Number(path[i])];
            } else if (isMap(value)) {
                if (!(path[i] in value)) return { problem: `unknown reference "${ref}"; ${Object.keys(value).length ? `${at} has ${keysOf(value, at)}` : `${at} is empty`}`, waits };
                value = value[path[i]];
            } else {
                break;
            }
        }
        waits.push(...pendingIn(value));
    }
    return { waits };
}

const templateError = (e: unknown) => {
    const message = (e as Error).message;
    return message.startsWith("template:") ? message : `template: ${message.replace(/^\(unknown path\)\s*(\[Line \d+, Column \d+\])?\s*/, "").replace(/\s*\n\s*/g, " ")}`;
};

/** `{{ … }}` blocks, and whether a template has `{% … %}` tags too. */
const BLOCK = /\{\{-?[\s\S]*?-?\}\}/g;

/**
 * A template rendered with `lab`. One that uses secrets keeps its `{{ … }}` blocks with `secrets` as
 * written (rendered with their values later) and gets the others filled in; with `{% … %}` tags in
 * it, it can't be taken apart, so it may use secrets or the lab, not both.
 */
function renderOne(template: string, refs: LabRefs): { value: unknown } | { error: string } {
    try {
        if (!usesSecrets(template)) return { value: renderTemplate(template, { lab: refs }) };
        if (/\{%/.test(template)) {
            return refersToLab(template)
                ? { error: "a template with {% %} tags can use secrets or lab, not both; give the lab part a value of its own (a var)" }
                : { value: template };
        }
        return { value: template.replace(BLOCK, block => (usesSecrets(block) ? block : String(renderTemplate(block, { lab: refs }) ?? ""))) };
    } catch (e) {
        return { error: templateError(e) };
    }
}

/** Render the lab references in a document's spec; problems go to `report` at the value's dot path. */
export function renderLabRefs(value: unknown, refs: LabRefs, at: string, report: (path: string, message: string) => void): unknown {
    if (typeof value === "string") {
        if (!isTemplate(value) || !refersToLab(value)) return value;
        let check: ReturnType<typeof referenceCheck>;
        try {
            check = referenceCheck(value, refs);
        } catch (e) {
            report(at, templateError(e));
            return value;
        }
        if (check.problem) {
            report(at, check.problem);
            return value;
        }
        if (check.waits.length > 0) {
            report(at, waitProblem(check.waits, refs));
            return value;
        }
        const result = renderOne(value, refs);
        if ("error" in result) {
            report(at, result.error);
            return value;
        }
        return result.value;
    }
    if (Array.isArray(value)) return value.map((v, i) => renderLabRefs(v, refs, `${at}[${i}]`, report));
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderLabRefs(v, refs, at ? `${at}.${k}` : k, report)]));
    }
    return value;
}

/** Why values it refers to couldn't be filled in: a circle of references, or a problem of their own. */
function waitProblem(waits: Pending[], refs: LabRefs): string {
    const waitsOf = (p: Pending): Pending[] => {
        if (p.template === undefined) return [];
        try {
            return referenceCheck(p.template, refs).waits;
        } catch {
            return [];
        }
    };
    // A circle through what this waits for: the first one found, as its paths.
    for (const start of waits) {
        const seen: Pending[] = [];
        let at: Pending | undefined = start;
        while (at && !seen.includes(at)) {
            seen.push(at);
            at = waitsOf(at)[0];
        }
        if (at) {
            const circle = seen.slice(seen.indexOf(at)).map(p => p.path);
            return `refers to ${start.path}, which can't be filled in: ${[...circle, circle[0]].join(" → ")} go round in a circle`;
        }
    }
    const names = [...new Set(waits.map(p => p.path))];
    return `refers to ${names.join(", ")}, which can't be filled in (see ${names.length > 1 ? "their" : "its"} own problem)`;
}

/**
 * A Lab document's spec with the personal config's `vars` under its own: maps merged key by key,
 * the lab's values winning.
 */
export function withPersonalVars(spec: unknown, vars: Record<string, unknown> | undefined): unknown {
    if (!vars || Object.keys(vars).length === 0 || !isMap(spec ?? {})) return spec;
    const merge = (base: unknown, over: unknown): unknown => {
        if (!isMap(base) || !isMap(over)) return over === undefined ? base : over;
        const out: Record<string, unknown> = { ...base };
        for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
        return out;
    };
    const own = (spec ?? {}) as Record<string, unknown>;
    return { ...own, vars: merge(vars, own.vars ?? {}) };
}

/**
 * Render the Lab document's spec: its values may refer to each other, at any depth. Filled in round
 * by round, each round the values whose references are all done; what's left (a circle, a value
 * with a problem of its own) is reported at its path.
 */
export function renderLabSpec(name: unknown, spec: unknown, at: string, report: (path: string, message: string) => void): unknown {
    let current: unknown = spec ?? {};
    for (;;) {
        const refs = labRefsOf({ name, spec: current });
        let progress = false;
        const round = (v: unknown): unknown => {
            if (typeof v === "string") {
                if (!isTemplate(v) || !refersToLab(v)) return v;
                try {
                    const check = referenceCheck(v, refs);
                    if (check.problem || check.waits.length > 0) return v;
                } catch {
                    return v;
                }
                const result = renderOne(v, refs);
                if ("error" in result) return v;
                progress = true;
                return result.value;
            }
            if (Array.isArray(v)) return v.map(round);
            if (isMap(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
            return v;
        };
        const next = round(current);
        if (!progress) break;
        current = next;
    }
    // What's left, reported: with every other value filled in.
    return renderLabRefs(current, labRefsOf({ name, spec: current }), at, report);
}
