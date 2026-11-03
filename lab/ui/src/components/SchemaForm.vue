<script setup lang="ts">
import { computed } from "vue";
import type { SettingSchema } from "../api";
import { useDoc } from "../doc";
import { visible } from "../form";
import { append, remove, type Path } from "../store";
import SchemaField from "./SchemaField.vue";

// Fields of a document's form, generated from its schema (DESIGN.md §5.5), at `at` in the document
// (default `spec`): those whose `form.section` is `section` (default `main`), or the `only` ones,
// in the schema's order. An `inline` object's fields join its parent's. `cards`: each list of
// objects as a card per item, with "+ add". A slot named after a field replaces its control (the
// editor's own: a key that's text or a file). The editor provides the lab's lists and values
// (FORM_CONTEXT) and `newItem`, a new card's fields. `inline`: no grid of its own, for a parent's.
const props = withDefaults(defineProps<{
  index: number;
  schema: SettingSchema;
  section?: string;
  at?: Path;
  only?: string[];
  inline?: boolean;
  newItem?: (field: string) => Record<string, unknown>;
}>(), { section: "main", at: () => ["spec"] });
const { get, bind, issue } = useDoc(() => props.index);
const here = computed<Record<string, any>>(() => (get(props.at) as Record<string, any> | undefined) ?? {});

/**
 * The engine's error on the object these fields are in (below `spec`): a profile needs it there (a
 * network's load-balancer pool). It shows on the object's required fields, which then are required.
 */
const own = computed(() => (props.at.length > 1 ? issue(props.at) : undefined));
const needed = (parent: SettingSchema, key: string) => !!parent.required?.includes(key) && parent.properties?.[key]?.default === undefined;
/** Required by the schema, without a default; not while the object it's in isn't there and nothing asks for it (an optional pool). */
const required = (parent: SettingSchema, key: string) => (get(props.at) !== undefined || !!own.value) && needed(parent, key);
/** A field's binding, with the object's error on its required fields. */
const bindRow = (f: Row) => {
  const b = bind(f.path);
  return own.value && f.required && !b.problem ? { ...b, problem: own.value } : b;
};
type Row = { key: string; path: Path; schema: SettingSchema; required: boolean };
/** The fields to show: `inline` objects' fields in their place, hidden ones (`const`, `unless`, `when`) left out. */
const fields = computed<Row[]>(() => {
  const picked = (key: string, s: SettingSchema) =>
    !s.form?.cards && (props.only ? props.only.includes(key) : (s.form?.section ?? "main") === props.section);
  return Object.entries(props.schema.properties ?? {}).filter(([key, s]) => picked(key, s) && s.const === undefined).flatMap(([key, s]): Row[] => {
    if (!visible(s.form, here.value)) return [];
    if (!s.form?.inline) return [{ key, path: [...props.at, key], schema: s, required: required(props.schema, key) }];
    const inner = (here.value[key] ?? {}) as Record<string, unknown>;
    return Object.entries(s.properties ?? {}).filter(([, c]) => visible(c.form, inner))
      .map(([sub, c]) => ({ key: `${key}.${sub}`, path: [...props.at, key, sub], schema: c, required: required(s, sub) }));
  });
});
const cards = computed(() => (props.section === "cards" ? Object.entries(props.schema.properties ?? {}).filter(([, s]) => s.form?.cards) : []));
const items = (key: string): Record<string, unknown>[] => here.value[key] ?? [];
const noun = (s: SettingSchema) => s.form!.cards!.add.replace(/^an? /, "");
</script>

<template>
  <template v-if="inline">
    <template v-for="f in fields" :key="f.key">
      <slot v-if="$slots[f.key]" :name="f.key" v-bind="bindRow(f)" />
      <SchemaField v-else :schema="f.schema" :label="f.key.split('.').pop()!" :required="f.required" v-bind="bindRow(f)" />
    </template>
  </template>
  <div v-else-if="fields.length || $slots.default" class="grid">
    <slot />
    <template v-for="f in fields" :key="f.key">
      <slot v-if="$slots[f.key]" :name="f.key" v-bind="bindRow(f)" />
      <SchemaField v-else :schema="f.schema" :label="f.key.split('.').pop()!" :required="f.required" v-bind="bindRow(f)" />
    </template>
  </div>
  <section v-for="[key, s] in cards" :key="key">
    <h3>{{ s.form?.label ?? key }}</h3>
    <p v-if="s.form?.hint ?? s.description" class="muted">{{ s.form?.hint ?? s.description }}</p>
    <div v-for="(item, i) in items(key)" :key="i" class="card">
      <header>
        <strong>{{ item[s.form!.cards!.title] || noun(s) }}</strong>
        <button type="button" class="icon" :title="`Remove ${noun(s)}`" @click="remove(index, [...at, key, i])">×</button>
      </header>
      <div class="grid">
        <template v-for="(field, sub) in s.items?.properties ?? {}" :key="sub">
          <SchemaField
            v-if="visible(field.form, item)"
            :schema="field"
            :label="String(sub)"
            :required="required(s.items!, String(sub))"
            :vars="{ item }"
            v-bind="bind([...at, key, i, String(sub)])"
          />
        </template>
      </div>
    </div>
    <button type="button" class="link" @click="append(index, [...at, key], newItem?.(key) ?? {})">+ add {{ s.form?.cards?.add }}</button>
  </section>
</template>
