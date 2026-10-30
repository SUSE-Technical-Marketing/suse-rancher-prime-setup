import { isTemplate, renderTemplate } from "./templates";

// Secrets in lab files, the personal config and catalog documents are Jinja2 templates over
// `secrets` (DESIGN.md §10): "{{ secrets.appco }}", "{{ secrets['ssh-key'] }}" (a name with a dash),
// "{{ secrets.scc.password }}", "{{ secrets.cloudflare.tunnel.token }}", or text around them
// ("Bearer {{ secrets.token }}"). The values only exist in the CLI and the program; the resolver
// renders each template against placeholders to check it and to find which secrets it uses, and how.

/**
 * What a secret's value must be: a string; credentials (a map with a username and a password); or
 * a map with at least these fields (`{ fields: ["accessKey", "secretKey"] }`).
 */
export type SecretShape = "string" | "credentials" | { fields: string[] };

const CREDENTIAL_FIELDS = ["password", "username"];

/** The fields a map shape needs; none for a string. */
export const shapeFields = (shape: SecretShape): string[] =>
    shape === "string" ? [] : shape === "credentials" ? CREDENTIAL_FIELDS : shape.fields;

/** A map shape with these fields: credentials when they're a username and a password. */
export function mapShape(fields: Iterable<string>): SecretShape {
    const sorted = [...new Set(fields)].sort();
    return sorted.every(f => CREDENTIAL_FIELDS.includes(f)) ? "credentials" : { fields: sorted };
}

/** Two uses of one secret together: undefined when one is a string and the other a map. */
export function mergeShapes(a: SecretShape, b: SecretShape): SecretShape | undefined {
    if (a === "string" || b === "string") return a === b ? a : undefined;
    return mapShape([...shapeFields(a), ...shapeFields(b)]);
}

/** `string`, `credentials`, or `a map with accessKey, secretKey`: for messages. */
export const describeShape = (shape: SecretShape) =>
    typeof shape === "string" ? shape : `a map with ${shape.fields.join(", ")}`;

/** One secret a template uses: whole (a string secret, or the map a field needs) or by field. */
export interface SecretUse {
    name: string;
    shape: SecretShape;
}

/** `{{ secrets.name }}`, `{{ secrets['name'] }}` or a path into one (`{{ secrets.cloudflare.tunnel.token }}`) and nothing else. */
const PATH = /^\s*\{\{-?\s*secrets((?:\s*(?:\.\s*[A-Za-z_][\w]*|\[\s*'[^']+'\s*\]|\[\s*"[^"]+"\s*\]))+)\s*-?\}\}\s*$/;
/** What a field of a secret may be called. */
const FIELD = /^[A-Za-z_][\w-]*$/;
const SEGMENT = /\.\s*([A-Za-z_][\w]*)|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\]/g;

/** The path a template is exactly (the secret's name, then fields), or undefined when it's anything more. */
export function secretPath(template: string): string[] | undefined {
    const m = PATH.exec(template);
    return m ? [...m[1].matchAll(SEGMENT)].map(s => s[1] ?? s[2] ?? s[3]) : undefined;
}

/** The secret a template is exactly, or undefined when it's anything more. */
export function wholeSecret(template: string): string | undefined {
    const path = secretPath(template);
    return path?.length === 1 ? path[0] : undefined;
}

/** A field's value in a map secret, by a dotted path (`tunnel.token`). */
export function fieldAt(value: unknown, field: string): unknown {
    return field.split(".").reduce<unknown>((v, k) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined), value);
}

/** What a secret must be for a use of it at a path to have `shape`: a map with that path's fields. */
function shapeAt(rest: string[], shape: SecretShape): SecretShape {
    if (!rest.length) return shape;
    const at = rest.join(".");
    return shape === "string" ? mapShape([at]) : mapShape(shapeFields(shape).map(f => `${at}.${f}`));
}

/**
 * `secrets` for a dry run: every name exists. A secret is a string placeholder (so filters work on
 * it); reading a field of it (`.password`, `.tunnel.token`) makes it a map with that field, by its
 * dotted path. Uses are known after the render.
 */
export function secretPlaceholders(): { secrets: Record<string, unknown>; uses: () => SecretUse[]; badField: () => string | undefined } {
    const used = new Set<string>();
    const fields = new Map<string, Set<string>>();
    let bad: string | undefined;
    const placeholder = (name: string, path: string[]): unknown => new Proxy(new String("x"), {
        get(target, key) {
            if (typeof key === "string" && !(key in String.prototype) && !/^\d+$/.test(key)) {
                if (!FIELD.test(key)) {
                    bad ??= `secrets.${[name, ...path].join(".")}: "${key}" can't be a field of a secret`;
                    return undefined;
                }
                const field = [...path, key];
                fields.set(name, (fields.get(name) ?? new Set()).add(field.join(".")));
                return placeholder(name, field);
            }
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
        },
    });
    /** A field read on the way to a deeper one (`tunnel` for `tunnel.token`) is a map, not a field. */
    const leaves = (set: Set<string>) => [...set].filter(f => ![...set].some(o => o.startsWith(`${f}.`)));
    return {
        secrets: new Proxy({}, {
            get: (_t, name) => {
                if (typeof name !== "string") return undefined;
                used.add(name);
                return placeholder(name, []);
            },
            has: () => true,
        }),
        uses: () => [...used].map(name => ({ name, shape: fields.has(name) ? mapShape(leaves(fields.get(name)!)) : "string" as const })),
        badField: () => bad,
    };
}

export interface SecretCheck {
    uses: SecretUse[];
    /** What's wrong with the template (syntax, an unknown variable), or undefined. */
    error?: string;
}

/**
 * The secrets a value uses. `shape` is what the field needs: a credentials (or other map) field may
 * be exactly one secret (`{{ secrets.harbor }}`), which then has to hold those fields. `vars` are
 * the other names the template may use (`lab` in an OS profile's cloud-init).
 */
export function checkSecretTemplate(template: string, shape: SecretShape, vars: Record<string, unknown> = {}): SecretCheck {
    const path = secretPath(template);
    // A field the dry run would reject ("a b") takes the long way, for its message.
    if (path && path.slice(1).every(k => FIELD.test(k))) return { uses: [{ name: path[0], shape: shapeAt(path.slice(1), shape) }] };
    const dry = secretPlaceholders();
    try {
        const out = renderTemplate(template, { ...vars, secrets: dry.secrets });
        const bad = dry.badField();
        if (bad) return { uses: dry.uses(), error: bad };
        if (shape !== "string") return { uses: dry.uses(), error: shape === "credentials"
            ? "credentials are one secret ({{ secrets.name }}) or { username, password }"
            : `must be one secret ({{ secrets.name }}) or { ${shapeFields(shape).join(", ")} }` };
        if (typeof out === "object" && out !== null && !(out instanceof String)) return { uses: dry.uses(), error: "renders to a map or list; a secret field takes a single value" };
    } catch (e) {
        return { uses: dry.uses(), error: dry.badField() ?? (e as Error).message };
    }
    return { uses: dry.uses() };
}

/** Does a string use secrets? Plain strings and other templates (`{{ settings.x }}`) don't. */
export const usesSecrets = (s: string) => isTemplate(s) && /\bsecrets\b/.test(s);

/** Render a secret template with the resolved values: a string, or a map for a whole map secret. */
export function renderSecretTemplate(template: string, secrets: Record<string, unknown>): unknown {
    const path = secretPath(template);
    if (path) {
        if (!(path[0] in secrets)) throw new Error(`secret "${path[0]}" is not resolved`);
        return path.length === 1 ? secrets[path[0]] : fieldAt(secrets[path[0]], path.slice(1).join("."));
    }
    return renderTemplate(template, { secrets });
}

/**
 * A map value (one secret holding the fields, or the fields themselves, each a value or a
 * template), as its fields. Credentials are the map with `username` and `password`.
 */
export function mapOf<F extends string>(value: string | Record<F, string>, fields: readonly F[], render: (template: string) => unknown): Record<F, string> {
    if (typeof value === "string") {
        const v = render(value) as Record<string, unknown>;
        if (typeof v !== "object" || v === null || fields.some(f => typeof v[f] !== "string")) {
            throw new Error(`${value} doesn't give ${fields.join(" and ")}`);
        }
        return Object.fromEntries(fields.map(f => [f, v[f]])) as Record<F, string>;
    }
    const str = (s: string) => (isTemplate(s) ? String(render(s)) : s);
    return Object.fromEntries(fields.map(f => [f, str(value[f])])) as Record<F, string>;
}

/** A credentials value (one secret, or a username with a password), as a username and password. */
export function credentialsOf(value: string | { username: string; password: string }, render: (template: string) => unknown): { username: string; password: string } {
    try {
        return mapOf(value, ["username", "password"], render);
    } catch {
        throw new Error(`${value} doesn't give a username and a password`);
    }
}
