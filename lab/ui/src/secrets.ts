// Secret templates as lab files write them (DESIGN.md §5.1): "{{ secrets.appco }}", with brackets
// for a name with a dash ("{{ secrets['ssh-key'] }}"), or a path into a map secret
// ("{{ secrets.cloudflare.tunnel.token }}"). The same rules as packages/schema/src/secrets.ts.

const PATH = /^\s*\{\{-?\s*secrets((?:\s*(?:\.\s*[A-Za-z_][\w]*|\[\s*'[^']+'\s*\]|\[\s*"[^"]+"\s*\]))+)\s*-?\}\}\s*$/;
const SEGMENT = /\.\s*([A-Za-z_][\w]*)|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\]/g;

/** The secret (and fields in it) a value is exactly, or undefined. */
export function secretPath(value: unknown): string[] | undefined {
    if (typeof value !== "string") return undefined;
    const m = PATH.exec(value);
    return m ? [...m[1].matchAll(SEGMENT)].map(s => s[1] ?? s[2] ?? s[3]) : undefined;
}

/** The template for one secret, or a field in one. */
export const secretTemplate = (path: string | string[]) =>
    `{{ secrets${(typeof path === "string" ? [path] : path).map(k => (/^[A-Za-z_]\w*$/.test(k) ? `.${k}` : `['${k}']`)).join("")} }}`;

export const isTemplate = (value: unknown) => typeof value === "string" && (value.includes("{{") || value.includes("{%"));
