import type { InjectionKey } from "vue";
import type { FormOptions } from "../../packages/schema/src/form";

// What a form generated from a schema (SchemaForm, SchemaField) needs from its editor: the lab's
// lists its fields choose from, and the values its placeholders and hints name (`{defaults.vm.cpu}`).

export type Option = string | { value: string; label: string };

export interface FormContext {
    options: Partial<Record<FormOptions, Option[]>>;
    vars: Record<string, unknown>;
}

export const FORM_CONTEXT: InjectionKey<() => FormContext> = Symbol("form context");

/** Whether a field shows, by its `unless` and `when`, given its siblings' values. */
export function visible(form: { unless?: { field: string; is: string }; when?: { field: string; matches: string } } | undefined, siblings: Record<string, unknown>): boolean {
    if (form?.unless && String(siblings[form.unless.field] ?? "") === form.unless.is) return false;
    if (form?.when && !new RegExp(form.when.matches).test(String(siblings[form.when.field] ?? ""))) return false;
    return true;
}

/** A template's `{dot.path}`s filled in from `vars`; one that names nothing stays as it is. */
export function fill(template: string | undefined, vars: Record<string, unknown>): string | undefined {
    if (template === undefined) return undefined;
    return template.replace(/\{([A-Za-z_][\w.]*)\}/g, (whole, path: string) => {
        const value = path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), vars);
        return value === undefined ? whole : Array.isArray(value) ? value.join(", ") : String(value);
    });
}
