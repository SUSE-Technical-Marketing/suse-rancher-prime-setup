<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { append, catalog, remove } from "../store";
import CredentialsField from "./CredentialsField.vue";
import DocHeader from "./DocHeader.vue";
import ListField from "./ListField.vue";
import RangeField from "./RangeField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
const name = computed(() => v.value.metadata?.name ?? "");
const fromPersonal = computed(() => catalog.value?.personal.harvesters.includes(name.value));
const vlans = computed<any[]>(() => v.value.spec?.networks?.vlans ?? []);
const networks = computed(() => ["untagged", ...vlans.value.map(n => `vlan${n.id}`)]);
const bools = [{ value: "true", label: "true" }, { value: "false", label: "false" }];

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
      <h3>DNS</h3>
      <p class="muted">Registers every VM's name with your DNS server.</p>
      <div class="grid">
        <SelectField label="backend" :options="['routeros']" empty="none" v-bind="bind('spec.dns.backend')" />
        <TextField label="host" placeholder="10.0.0.1" format="ip" v-bind="bind('spec.dns.host')" />
        <CredentialsField label="credentials" v-bind="bind('spec.dns.credentials')" />
      </div>
    </section>

    <section>
      <h3>Networks</h3>
      <div class="grid">
        <SelectField label="default" :options="networks" empty="untagged" hint="where hosts and pools go unless they say" v-bind="bind('spec.networks.default')" />
      </div>
      <div v-for="(vlan, i) in vlans" :key="i" class="card">
        <header>
          <strong>vlan{{ vlan.id }}</strong>
          <button type="button" class="icon" title="Remove VLAN" @click="remove(index, ['spec', 'networks', 'vlans', i])">×</button>
        </header>
        <div class="grid">
          <TextField label="VLAN id" number required v-bind="bind(['spec', 'networks', 'vlans', i, 'id'])" />
          <TextField label="DHCP CIDR" required placeholder="10.0.20.0/24" format="cidr" v-bind="bind(['spec', 'networks', 'vlans', i, 'dhcp', 'cidr'])" />
          <TextField label="gateway" required placeholder="10.0.20.1" format="ip" v-bind="bind(['spec', 'networks', 'vlans', i, 'dhcp', 'gateway'])" />
          <RangeField label="DHCP range" required v-bind="bind(['spec', 'networks', 'vlans', i, 'dhcp', 'range'])" />
          <TextField label="DHCP server" placeholder="default: the second address" format="ip" v-bind="bind(['spec', 'networks', 'vlans', i, 'dhcp', 'server'])" />
          <ListField label="DNS servers" placeholder="default: the gateway" format="ip" v-bind="bind(['spec', 'networks', 'vlans', i, 'dhcp', 'dns'])" />
          <RangeField label="load-balancer range" hint="a Harvester LB pool for guest clusters (harvester-cloud-provider)" v-bind="bind(['spec', 'networks', 'vlans', i, 'loadBalancer', 'range'])" />
        </div>
      </div>
      <button type="button" class="link" @click="addVlan">+ add a VLAN</button>
    </section>

    <details class="advanced">
      <summary>More</summary>
      <div class="grid">
        <YamlField label="untagged network" hint="{ dhcp, loadBalancer } on the untagged network" v-bind="bind('spec.networks.untagged')" />
        <TextField label="cluster network" placeholder="default mgmt" v-bind="bind('spec.clusterNetwork')" />
        <YamlField label="storage class" hint="{ name, replicas, parameters }, merged over the defaults" v-bind="bind('spec.storageClass')" />
      </div>
    </details>
  </div>
</template>
