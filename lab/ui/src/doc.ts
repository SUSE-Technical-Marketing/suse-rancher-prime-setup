import { computed } from "vue";
import { get, set, toPath, views, type Path } from "./store";

/** One document for an editor: its view, and `bind("spec.cpu")` for `v-bind` on a field. */
export function useDoc(index: () => number) {
    const v = computed(() => views.value[index()] ?? {});
    const at = (path: Path | string) => (typeof path === "string" ? toPath(path) : path);
    return {
        v,
        get: (path: Path | string) => get(v.value, at(path)),
        set: (path: Path | string, value: unknown) => set(index(), at(path), value),
        bind: (path: Path | string) => ({
            modelValue: get(v.value, at(path)),
            "onUpdate:modelValue": (value: unknown) => set(index(), at(path), value),
        }),
    };
}
