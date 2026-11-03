<script setup lang="ts">
import { computed, provide } from "vue";
import type { SettingSchema } from "../api";
import { useDoc } from "../doc";
import { FORM_CONTEXT } from "../form";
import { catalog, views } from "../store";
import DocHeader from "./DocHeader.vue";
import SchemaForm from "./SchemaForm.vue";

// An AWS account and region Rancher creates machines in; the lab gets a VPC of its own there. Its
// fields come from its schema (SchemaForm); here are what the personal config says and the subnets.
const props = defineProps<{ index: number }>();
const { v, set } = useDoc(() => props.index);
const schema = computed<SettingSchema>(() => catalog.value?.documentForms.AwsSite ?? {});
const name = computed(() => v.value.metadata?.name ?? "");
const mine = computed(() => catalog.value?.personal.awsSites.find(s => s.name === name.value));
const aws = computed(() => catalog.value?.defaults.aws);
const region = computed(() => v.value.spec?.region ?? mine.value?.region ?? "");
const zones = computed<string[]>(() => v.value.spec?.zones ?? aws.value?.zones ?? []);
/** What the engine cuts from the VPC: a sixteenth per zone. */
const subnets = computed(() => {
  const cidr: string = v.value.spec?.vpc?.cidr ?? aws.value?.vpcCidr ?? "";
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!m) return [];
  const prefix = Number(m[5]);
  const base = m.slice(1, 5).reduce((n, o) => n * 256 + Number(o), 0);
  const size = 2 ** (32 - prefix - 4);
  const ip = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join(".");
  return zones.value.map((z, i) => `${region.value || "<region>"}${z} ${ip(base + i * size)}/${prefix + 4}`);
});
const clusters = computed(() => views.value.filter(d => d.kind === "DownstreamCluster" && d.spec?.site === name.value).map(d => d.metadata?.name));
provide(FORM_CONTEXT, () => ({
  options: {},
  vars: { defaults: catalog.value?.defaults, regionPlaceholder: mine.value?.region ? `from your config: ${mine.value.region}` : "eu-west-1" },
}));
</script>

<template>
  <div class="editor">
    <DocHeader kind="AwsSite" :name="name" name-hint="as in your personal config's awsSites:" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Account</h3>
      <p v-if="mine" class="muted">Region and keys can come from your personal config (awsSites.{{ name }}); set them here only to override.</p>
      <p v-else-if="!v.spec?.region || !v.spec?.credentials" class="warn-text">{{ name || "This site" }} isn't in your personal config: give its region and keys here or there.</p>
      <p v-else class="muted">Not in your personal config: the region and keys here are the ones used.</p>
      <SchemaForm :index="index" :schema="schema" />
    </section>

    <section>
      <h3>Network</h3>
      <p class="muted">The lab's own VPC, with a public subnet per zone and a security group for its machines. Several labs can share an account.</p>
      <SchemaForm :index="index" :schema="schema" section="network" />
      <p v-if="subnets.length" class="muted mono">{{ subnets.join(" · ") }}</p>
    </section>

    <section>
      <h3>Lifetime</h3>
      <SchemaForm :index="index" :schema="schema" section="lifetime" />
      <p class="muted">{{ clusters.length ? `Clusters here: ${clusters.join(", ")}.` : "No EC2 or EKS cluster uses this site yet: its VPC is created anyway." }}</p>
    </section>
  </div>
</template>
