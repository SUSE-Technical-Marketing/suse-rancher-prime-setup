<script setup lang="ts">
import { computed, provide } from "vue";
import type { SettingSchema } from "../api";
import { useDoc } from "../doc";
import { FORM_CONTEXT } from "../form";
import { catalog, views } from "../store";
import DocHeader from "./DocHeader.vue";
import ProfilesEditor from "./ProfilesEditor.vue";
import SchemaForm from "./SchemaForm.vue";

// A HarvesterVM (a VM the lab creates) or a Machine (an existing one, reached over SSH): its fields
// from its kind's schema (SchemaForm), with the lab's Harvesters, OS profiles and networks.
const props = defineProps<{ index: number }>();
const { v, set } = useDoc(() => props.index);
const isVm = computed(() => v.value.kind === "HarvesterVM");
const schema = computed<SettingSchema>(() => catalog.value?.documentForms[v.value.kind ?? ""] ?? {});

const harvester = computed(() => views.value.find(d => d.kind === "Harvester" && d.metadata?.name === v.value.spec?.harvester));
/** `namespace/name`: a network already on the Harvester, which the lab doesn't declare. */
const existingNetwork = computed(() => typeof v.value.spec?.network === "string" && v.value.spec.network.includes("/"));

provide(FORM_CONTEXT, () => ({
  options: {
    harvesters: views.value.filter(d => d.kind === "Harvester").map(d => d.metadata?.name ?? ""),
    osProfiles: (catalog.value?.os ?? []).map(o => ({ value: o.name, label: `${o.name} — ${o.displayName}` })),
    networks: ["untagged", ...((harvester.value?.spec?.networks?.vlans ?? []) as any[]).map(n => `vlan${n.id}`)],
  },
  vars: {
    defaults: catalog.value?.defaults,
    ipPlaceholder: existingNetwork.value ? "10.29.40.200/24" : "from DHCP",
    ipHint: existingNetwork.value ? "with its prefix: the lab doesn't know this network" : "in the network's subnet, outside its DHCP range; set in the VM, no DHCP",
  },
}));

function setProfile(name: string, settings: Record<string, unknown> | undefined) {
  set(["spec", "profiles", name], settings ?? {});
}
</script>

<template>
  <div class="editor">
    <DocHeader :kind="v.kind ?? ''" :name="v.metadata?.name" :name-hint="isVm ? 'the VM, and its DNS name <name>.<domain>' : 'how the lab calls this machine'" @name="x => set('metadata.name', x)" />

    <section>
      <h3>{{ isVm ? "VM" : "Machine" }}</h3>
      <SchemaForm :index="index" :schema="schema" />
    </section>

    <ProfilesEditor :index="index" :model-value="v.spec?.profiles" :target="isVm ? 'harvester' : 'ssh'" @set="setProfile" @remove="n => set(['spec', 'profiles', n], undefined)" />

    <details class="advanced">
      <summary>More</summary>
      <SchemaForm :index="index" :schema="schema" section="advanced" />
    </details>
  </div>
</template>
