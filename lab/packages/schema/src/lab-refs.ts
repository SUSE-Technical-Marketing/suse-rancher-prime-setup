import * as nunjucks from "nunjucks";
import { isTemplate, renderTemplate } from "./templates";
import { usesSecrets } from "./secrets";

// References to the lab in a lab file's own documents (DESIGN.md §5.1): `lab` is the Lab document's
// spec with its `name`, as in profile templates, so `{{ lab.domain }}`, `{{ lab.name }}`,
// `{{ lab.tls.email }}`, in any string of the Lab document and of its Harvesters, AWS sites, hosts
// and clusters, e.g. `hosted-domain: "{{ lab.domain }}"`. They're rendered when the file loads,
// before its documents are checked, so `address: "nuc.{{ lab.domain }}"` is checked as the name it
// gives. A reference to anything the Lab document doesn't have is an error at the value's path,
// never left in the lab as text. Values that use secrets are left alone: they're rendered with the
// secrets' values later (§10).

/** What a lab file's templates see as `lab`. */
export type LabRefs = Record<string, unknown>;

/** A Lab document value that is a template itself, while the Lab document is being rendered. */
const PENDING = Symbol("a template");

/**
 * `lab` for rendering the Lab document itself: its values as written, the ones that are templates
 * marked, so `email: "admin@{{ lab.domain }}"` works and a reference to a template is an error.
 */
export function labRefsOf(main: { name?: unknown; spec?: unknown }): LabRefs {
    const mark = (v: unknown): unknown => {
        if (typeof v === "string") return isTemplate(v) ? PENDING : v;
        if (Array.isArray(v)) return v.map(mark);
        if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mark(x)]));
        return v;
    };
    const spec = typeof main.spec === "object" && main.spec !== null && !Array.isArray(main.spec) ? main.spec as Record<string, unknown> : {};
    return { ...(mark(spec) as Record<string, unknown>), name: typeof main.name === "string" ? main.name : PENDING };
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

/** What's wrong with a template's references to the lab, or undefined. */
function referenceProblem(template: string, refs: LabRefs): string | undefined {
    for (const path of referencesOf(template)) {
        const ref = path.join(".");
        if (path[0] !== "lab") return `unknown reference "${ref}"; a lab file's templates can use lab (the Lab document: ${keysOf(refs, "lab")}) and secrets`;
        // Down the Lab document's maps and lists; a key past a string or number is that value's own (lab.domain.length).
        let value: unknown = refs;
        for (let i = 1; i < path.length; i++) {
            const at = path.slice(0, i).join(".");
            if (value === PENDING) return `${at} is a template itself; refer to what it's made of`;
            if (Array.isArray(value)) {
                if (!/^\d+$/.test(path[i]) || Number(path[i]) >= value.length) return `unknown reference "${ref}"; ${at} is a list of ${value.length}`;
                value = value[Number(path[i])];
            } else if (isMap(value)) {
                if (!(path[i] in value)) return `unknown reference "${ref}"; ${Object.keys(value).length ? `${at} has ${keysOf(value, at)}` : `${at} is empty`}`;
                value = value[path[i]];
            } else {
                break;
            }
        }
        if (value === PENDING) return `${ref} is a template itself; refer to what it's made of`;
    }
    return undefined;
}

function renderOne(template: string, refs: LabRefs): { value: unknown } | { error: string } {
    try {
        const problem = referenceProblem(template, refs);
        if (problem) return { error: problem };
        return { value: renderTemplate(template, { lab: refs }) };
    } catch (e) {
        const message = (e as Error).message;
        return { error: message.startsWith("template:") ? message : `template: ${message.replace(/^\(unknown path\)\s*(\[Line \d+, Column \d+\])?\s*/, "").replace(/\s*\n\s*/g, " ")}` };
    }
}

/** Render the lab references in a document's spec; problems go to `report` at the value's dot path. */
export function renderLabRefs(value: unknown, refs: LabRefs, at: string, report: (path: string, message: string) => void): unknown {
    if (typeof value === "string") {
        if (!isTemplate(value) || usesSecrets(value)) return value;
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
