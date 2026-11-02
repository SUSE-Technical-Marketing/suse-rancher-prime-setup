<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { append, catalog, remove } from "../store";
import CredentialsField from "./CredentialsField.vue";
import DocHeader from "./DocHeader.vue";
import ListField from "./ListField.vue";
import ProfilesEditor from "./ProfilesEditor.vue";
import RangeField from "./RangeField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
const name = computed(() => v.value.metadata?.name ?? "");
const fromPersonal = computed(() => catalog.value?.personal.harvesters.includes(name.value));
const vlans = computed<any[]>(() => v.value.spec?.networks?.vlans ?? []);
/** The default's choices besides untagged, which is the empty choice: no default means untagged. */
const vlanNames = computed(() => vlans.value.map(n => `vlan${n.id}`));
const defaultNetwork = computed(() => (v.value.spec?.networks?.default === "untagged" ? undefined : v.value.spec?.networks?.default));
const bools = [{ value: "true", label: "true" }, { value: "false", label: "false" }];

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
      <div class="grid">
        <TextField label="url" placeholder="https://harvester.example.com" v-bind="bind('spec.url')" />
        <CredentialsField label="credentials" v-bind="bind('spec.credentials')" />
        <SelectField label="insecure" :options="bools" empty="default" hint="skip TLS verification (Harvester's self-signed certificate)"
          :model-value="v.spec?.insecure === undefined ? undefined : String(v.spec.insecure)"
          @update:model-value="x => set('spec.insecure', x === undefined ? undefined : x === 'true')" />
      </div>
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
          <TextField v-if="vlan !== undefined" label="VLAN id" number required v-bind="bind([...path, 'id'])" />
          <SelectField label="addresses" :options="ADDRESSING" :model-value="net.dhcp ? 'dhcp' : 'none'"
            :hint="vlan === undefined ? 'no lab DHCP when the LAN has a DHCP server (a home router), or for fixed addresses' : 'lab DHCP, or none: fixed addresses (or the LAN\'s DHCP)'"
            @update:model-value="x => setAddressing(path, net, x === 'dhcp')" />
          <template v-if="net.dhcp">
            <TextField label="DHCP CIDR" required placeholder="10.0.20.0/24" format="cidr" v-bind="bind([...path, 'dhcp', 'cidr'])" />
            <TextField label="gateway" required placeholder="10.0.20.1" format="ip" v-bind="bind([...path, 'dhcp', 'gateway'])" />
            <RangeField label="DHCP range" required hint="fixed addresses go outside it" v-bind="bind([...path, 'dhcp', 'range'])" />
            <TextField label="DHCP server" placeholder="default: the second address" format="ip" v-bind="bind([...path, 'dhcp', 'server'])" />
            <ListField label="DNS servers" placeholder="default: the gateway" format="ip" v-bind="bind([...path, 'dhcp', 'dns'])" />
          </template>
          <template v-else>
            <TextField label="CIDR" placeholder="203.0.113.0/24" format="cidr" hint="for its VMs' fixed addresses" v-bind="bind([...path, 'cidr'])" />
            <TextField label="gateway" placeholder="203.0.113.1" format="ip" v-bind="bind([...path, 'gateway'])" />
            <ListField label="DNS servers" placeholder="default: the gateway" format="ip" v-bind="bind([...path, 'dns'])" />
          </template>
          <RangeField label="load-balancer range" hint="a Harvester LB pool for guest clusters (harvester-cloud-provider)" v-bind="bind([...path, 'loadBalancer', 'range'])" />
        </div>
      </div>
      <button type="button" class="link" @click="addVlan">+ add a VLAN</button>
    </section>

    <details class="advanced">
      <summary>More</summary>
      <div class="grid">
        <TextField label="cluster network" placeholder="default mgmt" v-bind="bind('spec.clusterNetwork')" />
        <YamlField label="storage class" hint="{ name, replicas, parameters }, merged over the defaults" v-bind="bind('spec.storageClass')" />
      </div>
    </details>
    <ProfilesEditor :model-value="v.spec?.profiles" target="hci" @set="(n, x) => set(['spec', 'profiles', n], x ?? {})" @remove="n => set(['spec', 'profiles', n], undefined)" />
  </div>
</template>
