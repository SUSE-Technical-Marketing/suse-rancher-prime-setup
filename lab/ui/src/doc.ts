import { computed } from "vue";
import { check, docOf, get, set, toPath, views, type Path } from "./store";

/** A path as the engine's diagnostics write it: `spec.networks.vlans[0].dhcp`. */
const dotted = (path: Path) => path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");

/**
 * One document for an editor: its view, and `bind("spec.cpu")` for `v-bind` on a field, which
 * brings the engine's error for that field (or for something in it: `range[1]`) as `problem`.
 */
export function useDoc(index: () => number) {
    const v = computed(() => views.value[index()] ?? {});
    const at = (path: Path | string) => (typeof path === "string" ? toPath(path) : path);
    /** This document's errors, by field. */
    const errors = computed(() => (check.value?.diagnostics ?? [])
        .filter(d => d.level === "error")
        .map(d => ({ ...docOf(d.path), message: d.message }))
        .filter(d => d.index === index() && d.field));
    const problem = (path: Path) => {
        const p = dotted(path);
        return errors.value.find(e => e.field === p || e.field.startsWith(`${p}.`) || e.field.startsWith(`${p}[`))?.message;
    };
    return {
        v,
        get: (path: Path | string) => get(v.value, at(path)),
        set: (path: Path | string, value: unknown) => set(index(), at(path), value),
        bind: (path: Path | string) => ({
            modelValue: get(v.value, at(path)),
            "onUpdate:modelValue": (value: unknown) => set(index(), at(path), value),
            problem: problem(at(path)),
        }),
    };
}
