import { isTemplate, renderTemplate } from "./templates";

// Secrets in lab files, the personal config and catalog documents are Jinja2 templates over
// `secrets` (DESIGN.md §10): "{{ secrets.appco }}", "{{ secrets['ssh-key'] }}" (a name with a dash),
// "{{ secrets.scc.password }}", or text around them ("Bearer {{ secrets.token }}"). The values only
// exist in the CLI and the program; the resolver renders each template against placeholders to
// check it and to find which secrets it uses, and how.

export type SecretShape = "string" | "credentials";

/** One secret a template uses: whole (a string secret) or by `.username` / `.password` (credentials). */
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
 * it); reading its `.username` or `.password` makes it credentials. Uses are known after the render.
 */
export function secretPlaceholders(): { secrets: Record<string, unknown>; uses: () => SecretUse[]; badField: () => string | undefined } {
    const used = new Set<string>();
    const fields = new Set<string>();
    let bad: string | undefined;
    const placeholder = (name: string) => new Proxy(new String("x"), {
        get(target, key) {
            if (key === "username" || key === "password") { fields.add(name); return "x"; }
            if (typeof key === "string" && !(key in String.prototype) && !/^\d+$/.test(key) && key !== "length") {
                bad ??= `secrets.${name}.${key}: a secret is a value, or credentials with a username and password`;
                return undefined;
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
        uses: () => [...used].map(name => ({ name, shape: fields.has(name) ? "credentials" as const : "string" as const })),
        badField: () => bad,
    };
}

export interface SecretCheck {
    uses: SecretUse[];
    /** What's wrong with the template (syntax, an unknown variable), or undefined. */
    error?: string;
}

/**
 * The secrets a value uses. `shape` is what the field needs: a credentials field may be exactly one
 * secret (`{{ secrets.harbor }}`), which then has to hold a username and a password. `vars` are the
 * other names the template may use (`lab` in an OS profile's cloud-init).
 */
export function checkSecretTemplate(template: string, shape: SecretShape, vars: Record<string, unknown> = {}): SecretCheck {
    const whole = wholeSecret(template);
    if (whole) return { uses: [{ name: whole, shape }] };
    const dry = secretPlaceholders();
    try {
        const out = renderTemplate(template, { ...vars, secrets: dry.secrets });
        const bad = dry.badField();
        if (bad) return { uses: dry.uses(), error: bad };
        if (shape === "credentials") return { uses: dry.uses(), error: "credentials are one secret ({{ secrets.name }}) or { username, password }" };
        if (typeof out === "object" && out !== null && !(out instanceof String)) return { uses: dry.uses(), error: "renders to a map or list; a secret field takes a single value" };
    } catch (e) {
        return { uses: dry.uses(), error: dry.badField() ?? (e as Error).message };
    }
    return { uses: dry.uses() };
}

/** Does a string use secrets? Plain strings and other templates (`{{ settings.x }}`) don't. */
export const usesSecrets = (s: string) => isTemplate(s) && /\bsecrets\b/.test(s);

/** Render a secret template with the resolved values: a string, or credentials for a whole credentials secret. */
export function renderSecretTemplate(template: string, secrets: Record<string, unknown>): unknown {
    const whole = wholeSecret(template);
    if (whole) {
        if (!(whole in secrets)) throw new Error(`secret "${whole}" is not resolved`);
        return secrets[whole];
    }
    return renderTemplate(template, { secrets });
}

/** A credentials value (one secret, or a username with a password), as a username and password. */
export function credentialsOf(value: string | { username: string; password: string }, render: (template: string) => unknown): { username: string; password: string } {
    if (typeof value === "string") {
        const v = render(value) as { username?: unknown; password?: unknown };
        if (typeof v !== "object" || v === null || typeof v.username !== "string" || typeof v.password !== "string") {
            throw new Error(`${value} doesn't give a username and a password`);
        }
        return { username: v.username, password: v.password };
    }
    const str = (s: string) => (isTemplate(s) ? String(render(s)) : s);
    return { username: str(value.username), password: str(value.password) };
}
