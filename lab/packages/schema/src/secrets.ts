import { isTemplate, renderTemplate } from "./templates";

// Secrets in lab files, the personal config and catalog documents are Jinja2 templates over
// `secrets` (DESIGN.md §10): "{{ secrets.appco }}", "{{ secrets['ssh-key'] }}" (a name with a dash),
// "{{ secrets.scc.password }}", "{{ secrets.aws.accessKey }}", or text around them
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

/** `{{ secrets.name }}` or `{{ secrets['name'] }}` and nothing else: the secret itself, any shape. */
const WHOLE = /^\s*\{\{-?\s*secrets\s*(?:\.\s*([A-Za-z_][\w]*)|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\])\s*-?\}\}\s*$/;

/** The secret a template is exactly, or undefined when it's anything more. */
export function wholeSecret(template: string): string | undefined {
    const m = WHOLE.exec(template);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * `secrets` for a dry run: every name exists. A secret is a string placeholder (so filters work on
 * it); reading a field of it (`.password`, `.accessKey`) makes it a map with that field. Uses are
 * known after the render.
 */
export function secretPlaceholders(): { secrets: Record<string, unknown>; uses: () => SecretUse[]; badField: () => string | undefined } {
    const used = new Set<string>();
    const fields = new Map<string, Set<string>>();
    let bad: string | undefined;
    const placeholder = (name: string) => new Proxy(new String("x"), {
        get(target, key) {
            if (typeof key === "string" && !(key in String.prototype) && !/^\d+$/.test(key)) {
                if (!/^[A-Za-z_][\w-]*$/.test(key)) {
                    bad ??= `secrets.${name}: "${key}" can't be a field of a secret`;
                    return undefined;
                }
                fields.set(name, (fields.get(name) ?? new Set()).add(key));
                return "x";
            }
            const v = Reflect.get(target, key, target);
            return typeof v === "function" ? v.bind(target) : v;
        },
    });
    return {
        secrets: new Proxy({}, {
            get: (_t, name) => {
                if (typeof name !== "string") return undefined;
                used.add(name);
                return placeholder(name);
            },
            has: () => true,
        }),
        uses: () => [...used].map(name => ({ name, shape: fields.has(name) ? mapShape(fields.get(name)!) : "string" as const })),
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
    const whole = wholeSecret(template);
    if (whole) return { uses: [{ name: whole, shape }] };
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
    const whole = wholeSecret(template);
    if (whole) {
        if (!(whole in secrets)) throw new Error(`secret "${whole}" is not resolved`);
        return secrets[whole];
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
