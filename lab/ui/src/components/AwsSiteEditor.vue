<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { catalog, views } from "../store";
import AwsCredentialsField from "./AwsCredentialsField.vue";
import DocHeader from "./DocHeader.vue";
import ListField from "./ListField.vue";
import TextField from "./TextField.vue";

// An AWS account and region Rancher creates machines in; the lab gets a VPC of its own there.
const props = defineProps<{ index: number }>();
const { v, bind, set } = useDoc(() => props.index);
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
const REGIONS = ["eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-south-1", "sa-east-1"];
</script>

<template>
  <div class="editor">
    <DocHeader kind="AwsSite" :name="name" name-hint="as in your personal config's awsSites:" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Account</h3>
      <p v-if="mine" class="muted">Region and keys can come from your personal config (awsSites.{{ name }}); set them here only to override.</p>
      <p v-else class="warn-text">{{ name || "This site" }} isn't in your personal config: give its region and keys here or there.</p>
      <div class="grid">
        <TextField label="region" :placeholder="mine?.region ? `from your config: ${mine.region}` : 'eu-west-1'" list="aws-regions" v-bind="bind('spec.region')" />
        <datalist id="aws-regions"><option v-for="r in REGIONS" :key="r" :value="r" /></datalist>
        <AwsCredentialsField label="credentials" v-bind="bind('spec.credentials')" />
      </div>
    </section>

    <section>
      <h3>Network</h3>
      <p class="muted">The lab's own VPC, with a public subnet per zone and a security group for its machines. Several labs can share an account.</p>
      <div class="grid">
        <TextField label="VPC CIDR" :placeholder="`default ${aws?.vpcCidr}`" hint="a /16 to /24; each zone gets a sixteenth" v-bind="bind('spec.vpc.cidr')" />
        <ListField label="zones" :placeholder="`default ${(aws?.zones ?? []).join(', ')}`" hint="by letter; pick others where the account lacks a or b" v-bind="bind('spec.zones')" />
      </div>
      <p v-if="subnets.length" class="muted mono">{{ subnets.join(" · ") }}</p>
    </section>

    <section>
      <h3>Lifetime</h3>
      <div class="grid">
        <TextField label="ttl" placeholder="none" hint="tagged as lab.geeko.me/expires, e.g. 8h; nothing deletes the lab by itself" v-bind="bind('spec.ttl')" />
      </div>
      <p class="muted">{{ clusters.length ? `Clusters here: ${clusters.join(", ")}.` : "No EC2 or EKS cluster uses this site yet: its VPC is created anyway." }}</p>
    </section>
  </div>
</template>
