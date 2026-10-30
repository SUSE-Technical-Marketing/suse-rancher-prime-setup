import { type Component, markRaw, shallowRef } from "vue";

// Lucide icons, each its own chunk, loaded the first time something shows it.
const modules = import.meta.glob<{ default: Component }>("../node_modules/lucide-vue-next/dist/esm/icons/*.js");
const loaded = new Map<string, ReturnType<typeof shallowRef<Component | undefined>>>();

/** An icon by its Lucide name (`ship-wheel`), filled in once loaded; an unknown one is a puzzle piece. */
export function iconRef(name: string) {
    let r = loaded.get(name);
    if (r) return r;
    r = shallowRef<Component>();
    loaded.set(name, r);
    const load = modules[`../node_modules/lucide-vue-next/dist/esm/icons/${name}.js`] ?? modules["../node_modules/lucide-vue-next/dist/esm/icons/puzzle.js"];
    const target = r;
    load?.().then(m => (target.value = markRaw(m.default)));
    return r;
}
