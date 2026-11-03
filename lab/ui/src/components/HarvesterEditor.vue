<script setup lang="ts">
import { computed } from "vue";
import type { SettingSchema } from "../api";
import { useDoc } from "../doc";
import { append, catalog, remove } from "../store";
import DocHeader from "./DocHeader.vue";
import ProfilesEditor from "./ProfilesEditor.vue";
import SchemaForm from "./SchemaForm.vue";
import SelectField from "./SelectField.vue";

// A Harvester: its fields from its schema (SchemaForm). Its networks are this editor's own cards
// (the untagged one always, then the VLANs), with a switch between lab DHCP and none; their
// fields come from the networks' schemas too.
const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
const schema = computed<SettingSchema>(() => catalog.value?.documentForms.Harvester ?? {});
const nets = computed(() => schema.value.properties?.networks?.properties ?? {});
/** A network's schema: the untagged one's, or a VLAN's (with its id). */
const netSchema = (vlan: boolean): SettingSchema => (vlan ? nets.value.vlans?.items : nets.value.untagged) ?? {};
const part = (s: SettingSchema, key: string): SettingSchema => s.properties?.[key] ?? {};
const name = computed(() => v.value.metadata?.name ?? "");
const fromPersonal = computed(() => catalog.value?.personal.harvesters.includes(name.value));
const vlans = computed<any[]>(() => v.value.spec?.networks?.vlans ?? []);
/** The default's choices besides untagged, which is the empty choice: no default means untagged. */
const vlanNames = computed(() => vlans.value.map(n => `vlan${n.id}`));
const defaultNetwork = computed(() => (v.value.spec?.networks?.default === "untagged" ? undefined : v.value.spec?.networks?.default));

/** The untagged network, always there, then the VLANs: the same fields, but for a VLAN's id. */
const networks = computed(() => [
  { key: "untagged", title: "untagged", path: ["spec", "networks", "untagged"] as (string | number)[], net: v.value.spec?.networks?.untagged ?? {}, vlan: undefined as number | undefined },
  ...vlans.value.map((net, i) => ({ key: `vlan-${i}`, title: `vlan${net.id}`, path: ["spec", "networks", "vlans", i] as (string | number)[], net, vlan: i as number | undefined })),
]);

const ADDRESSING = [{ value: "dhcp", label: "lab DHCP" }, { value: "none", label: "no lab DHCP" }];
/** Switch a network between lab DHCP and none, carrying its subnet, gateway and DNS servers across. */
function setAddressing(path: (string | number)[], net: any, dhcp: boolean) {
  if (dhcp && !net.dhcp) {
    const { cidr, gateway, dns, ...rest } = net;
    set(path, { ...rest, dhcp: { ...(cidr ? { cidr } : {}), ...(gateway ? { gateway } : {}), ...(dns ? { dns } : {}) } });
  } else if (!dhcp && net.dhcp) {
    const { dhcp: d, ...rest } = net;
    set(path, { ...rest, ...(d.cidr ? { cidr: d.cidr } : {}), ...(d.gateway ? { gateway: d.gateway } : {}), ...(d.dns ? { dns: d.dns } : {}) });
  }
}

function addVlan() {
  const ids = vlans.value.map(n => Number(n.id));
  append(props.index, ["spec", "networks", "vlans"], { id: ids.length ? Math.max(...ids) + 1 : 100 });
}
</script>

<template>
  <div class="editor">
    <DocHeader kind="Harvester" :name="name" name-hint="as in your personal config's harvesters:" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Connection</h3>
      <p v-if="fromPersonal" class="muted">URL and credentials come from your personal config (harvesters.{{ name }}); set them here only to override.</p>
      <p v-else-if="!v.spec?.url || !v.spec?.credentials" class="warn-text">{{ name || "This Harvester" }} isn't in your personal config: give its URL and credentials here or there.</p>
      <p v-else class="muted">Not in your personal config: the URL and credentials here are the ones used.</p>
      <SchemaForm :index="index" :schema="schema" />
    </section>

    <section>
      <h3>Networks</h3>
      <div class="grid">
        <SelectField label="default" :options="vlanNames" empty="untagged" hint="where hosts and pools go unless they say"
          :model-value="defaultNetwork" :problem="bind('spec.networks.default').problem" @update:model-value="x => set('spec.networks.default', x)" />
      </div>
      <div v-for="{ key, title, path, net, vlan } in networks" :key="key" class="card">
        <header>
          <strong>{{ title }}</strong>
          <button v-if="vlan !== undefined" type="button" class="icon" title="Remove VLAN" @click="remove(index, path)">×</button>
        </header>
        <div class="grid">
          <SchemaForm v-if="vlan !== undefined" inline :index="index" :schema="netSchema(true)" :at="path" :only="['id']" />
          <SelectField label="addresses" :options="ADDRESSING" :model-value="net.dhcp ? 'dhcp' : 'none'"
            :hint="vlan === undefined ? 'no lab DHCP when the LAN has a DHCP server (a home router), or for fixed addresses' : 'lab DHCP, or none: fixed addresses (or the LAN\'s DHCP)'"
            @update:model-value="x => setAddressing(path, net, x === 'dhcp')" />
          <SchemaForm v-if="net.dhcp" inline :index="index" :schema="part(netSchema(vlan !== undefined), 'dhcp')" :at="[...path, 'dhcp']" />
          <SchemaForm v-else inline :index="index" :schema="netSchema(vlan !== undefined)" :at="path" :only="['cidr', 'gateway', 'dns']" />
          <SchemaForm inline :index="index" :schema="part(netSchema(vlan !== undefined), 'loadBalancer')" :at="[...path, 'loadBalancer']" />
        </div>
      </div>
      <button type="button" class="link" @click="addVlan">+ add a VLAN</button>
    </section>

    <details class="advanced">
      <summary>More</summary>
      <SchemaForm :index="index" :schema="schema" section="advanced" />
    </details>
    <ProfilesEditor :index="index" :model-value="v.spec?.profiles" target="hci" @set="(n, x) => set(['spec', 'profiles', n], x ?? {})" @remove="n => set(['spec', 'profiles', n], undefined)" />
  </div>
</template>
