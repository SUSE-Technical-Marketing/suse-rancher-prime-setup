<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { catalog, views } from "../store";
import DocHeader from "./DocHeader.vue";
import ProfilesEditor from "./ProfilesEditor.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

// A HarvesterVM (a VM the lab creates) or a Machine (an existing one, reached over SSH).
const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
const isVm = computed(() => v.value.kind === "HarvesterVM");
const defaults = computed(() => catalog.value?.defaults.vm);

const harvesters = computed(() => views.value.filter(d => d.kind === "Harvester").map(d => d.metadata?.name ?? ""));
const harvester = computed(() => views.value.find(d => d.kind === "Harvester" && d.metadata?.name === v.value.spec?.harvester));
const networks = computed(() => ["untagged", ...((harvester.value?.spec?.networks?.vlans ?? []) as any[]).map(n => `vlan${n.id}`)]);
const osOptions = computed(() => (catalog.value?.os ?? []).map(o => ({ value: o.name, label: `${o.name} — ${o.displayName}` })));

/** k3s / RKE2 on the host, but not a -k8s OS profile: Longhorn and the SELinux policy would be missing. */
const k8sProfile = computed(() => Object.keys(v.value.spec?.profiles ?? {}).find(n => catalog.value?.profiles.find(p => p.name === n)?.distribution));
const k8sVariant = computed(() => {
  const os = v.value.spec?.os as string | undefined;
  if (!k8sProfile.value || !os || os.endsWith("-k8s")) return undefined;
  const variant = `${os}-k8s`;
  return catalog.value?.os.some(o => o.name === variant) ? variant : undefined;
});

function setProfile(name: string, settings: Record<string, unknown> | undefined) {
  set(["spec", "profiles", name], settings ?? {});
}
</script>

<template>
  <div class="editor">
    <DocHeader :kind="v.kind ?? ''" :name="v.metadata?.name" :name-hint="isVm ? 'the VM, and its DNS name <name>.<domain>' : 'how the lab calls this machine'" @name="x => set('metadata.name', x)" />

    <section>
      <h3>{{ isVm ? "VM" : "Machine" }}</h3>
      <div class="grid">
        <SelectField v-if="isVm" label="Harvester" required :options="harvesters" empty="—" v-bind="bind('spec.harvester')" />
        <TextField v-else label="address" required hint="its DNS name or IP" v-bind="bind('spec.address')" />
        <TextField v-if="!isVm" label="user" :placeholder="`default: the lab's ssh user`" v-bind="bind('spec.user')" />
        <SelectField label="OS" required :options="osOptions" :hint="isVm ? undefined : 'what the machine runs; its packages and runcmd run over SSH'" v-bind="bind('spec.os')" />
      </div>
      <p v-if="k8sVariant" class="warn-text">
        {{ k8sProfile }} runs here: use {{ k8sVariant }}, which has the SELinux policy and what Longhorn needs.
        <button type="button" class="link" @click="set('spec.os', k8sVariant)">Use {{ k8sVariant }}</button>
      </p>
      <div v-if="isVm" class="grid">
        <TextField label="CPUs" number :placeholder="`default ${defaults?.cpu}`" v-bind="bind('spec.cpu')" />
        <TextField label="memory" :placeholder="`default ${defaults?.memory}`" v-bind="bind('spec.memory')" />
        <TextField label="disk" :placeholder="`default ${defaults?.disk}`" v-bind="bind('spec.disk')" />
        <SelectField label="network" :options="networks" empty="the Harvester's default" v-bind="bind('spec.network')" />
        <TextField label="MAC address" placeholder="for a fixed DHCP lease" v-bind="bind('spec.macAddress')" />
      </div>
    </section>

    <ProfilesEditor :model-value="v.spec?.profiles" :host-kind="isVm ? 'harvester' : 'ssh'" @set="setProfile" @remove="n => set(['spec', 'profiles', n], undefined)" />

    <details class="advanced">
      <summary>More</summary>
      <div class="grid">
        <YamlField label="charts" hint="catalog HelmCharts to install after the profiles: [{ name, namespace, values }]" v-bind="bind('spec.charts')" />
        <YamlField label="secrets" hint="catalog secrets to create on the host's cluster" v-bind="bind('spec.secrets')" />
        <YamlField label="configmaps" hint="catalog configmaps to create on the host's cluster" v-bind="bind('spec.configmaps')" />
      </div>
    </details>
  </div>
</template>
