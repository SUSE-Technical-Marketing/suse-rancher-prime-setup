// Secret templates as lab files write them (DESIGN.md §5.1): "{{ secrets.appco }}", with brackets
// for a name with a dash ("{{ secrets['ssh-key'] }}"). The same rules as packages/schema/src/secrets.ts.

const WHOLE = /^\s*\{\{-?\s*secrets\s*(?:\.\s*([A-Za-z_][\w]*)|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\])\s*-?\}\}\s*$/;

/** The secret a value is exactly, or undefined. */
export function wholeSecret(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const m = WHOLE.exec(value);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** The template for one secret. */
export const secretTemplate = (name: string) => (/^[A-Za-z_]\w*$/.test(name) ? `{{ secrets.${name} }}` : `{{ secrets['${name}'] }}`);

export const isTemplate = (value: unknown) => typeof value === "string" && (value.includes("{{") || value.includes("{%"));
