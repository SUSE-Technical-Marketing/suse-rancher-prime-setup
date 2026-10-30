import * as nunjucks from "nunjucks";

// Jinja2 templates (Nunjucks) in a Profile's `values` and `lockedValues` (DESIGN.md §17): string
// values may hold `{{ … }}` / `{% … %}`. A string that is exactly one `{{ expression }}` yields the
// expression's own value (a boolean, a map); any other template renders to a string.

const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });

/** `{{ secrets.x }}` (or a path into it), exactly: its expression. */
const SECRET = /^\s*\{\{-?\s*(secrets(?:\.\s*[A-Za-z_]\w*|\[\s*'[^']+'\s*\]|\[\s*"[^"]+"\s*\])+)\s*-?\}\}\s*$/;

/**
 * `field('username')`: one field of a credentials (or other map) setting, for a chart value. Of a
 * secret template, the template for that field (`{{ secrets.appco }}` -> `{{ secrets.appco.username }}`),
 * rendered with the secrets' values only when the lab is built; of a map, its value. Nothing gives "".
 */
env.addFilter("field", (value: unknown, field: string) => {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string") {
        const m = SECRET.exec(value);
        if (!m) throw new Error(`field('${field}'): expects a secret ("{{ secrets.name }}") or a map, not a plain string`);
        return /^[A-Za-z_]\w*$/.test(field) ? `{{ ${m[1]}.${field} }}` : `{{ ${m[1]}['${field}'] }}`;
    }
    if (typeof value === "object" && !Array.isArray(value)) return (value as Record<string, unknown>)[field] ?? "";
    throw new Error(`field('${field}'): expects a secret or a map`);
});

const WHOLE = /^\s*\{\{([\s\S]*)\}\}\s*$/;
export const isTemplate = (s: string) => s.includes("{{") || s.includes("{%");

/** What a profile's templates can use. */
export interface TemplateContext {
    /** The profile's own settings, defaults applied. */
    settings: Record<string, unknown>;
    host: { name: string; fqdn: string };
    /** `tls.privateCA`: the ACME server's CA isn't trusted by default (Let's Encrypt staging). */
    lab: { name: string; domain: string; tls: { acme: string; privateCA: boolean; email?: string } };
    /** By capability: what the profiles on the same host that provide it declare under `outputs`. */
    outputs: Record<string, Record<string, unknown>>;
}

/** Nunjucks' messages start with where it thinks it is; ours say that already. */
const clean = (message: string) => message.replace(/^\(unknown path\)\s*(\[Line \d+, Column \d+\])?\s*/, "").trim().replace(/\s*\n\s*/g, " ");

function renderString(template: string, ctx: object): unknown {
    const whole = WHOLE.exec(template);
    // One expression and nothing else: keep its type.
    if (whole && !whole[1].includes("}}") && !whole[1].includes("{{")) {
        const json = env.renderString(`{{ (${whole[1]}) | dump }}`, ctx);
        return json === "" ? undefined : JSON.parse(json);
    }
    return env.renderString(template, ctx);
}

/** Render one template string; throws with a readable message on a problem. */
export function renderTemplate(template: string, ctx: object): unknown {
    try {
        return renderString(template, ctx);
    } catch (e) {
        throw new Error(`template: ${clean((e as Error).message)}`);
    }
}

/**
 * Render the templates in a values map. Problems (undefined variables, syntax errors) are reported
 * at the dot path of the value they're in; the value is left as it was.
 */
export function renderTemplates(value: unknown, ctx: object, at: string, error: (path: string, message: string) => void): unknown {
    if (typeof value === "string") {
        if (!isTemplate(value)) return value;
        try {
            return renderString(value, ctx);
        } catch (e) {
            error(at, `template: ${clean((e as Error).message)}`);
            return value;
        }
    }
    if (Array.isArray(value)) return value.map((v, i) => renderTemplates(v, ctx, `${at}[${i}]`, error));
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplates(v, ctx, at ? `${at}.${k}` : k, error)]));
    }
    return value;
}
