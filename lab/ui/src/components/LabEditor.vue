<script setup lang="ts">
import { computed } from "vue";
import { useDoc } from "../doc";
import { catalog } from "../store";
import CredentialsField from "./CredentialsField.vue";
import DocHeader from "./DocHeader.vue";
import ListField from "./ListField.vue";
import SecretField from "./SecretField.vue";
import SelectField from "./SelectField.vue";
import TextField from "./TextField.vue";
import YamlField from "./YamlField.vue";

const props = defineProps<{ index: number }>();
const { v, bind, set, get } = useDoc(() => props.index);
const acme = computed(() => [...(catalog.value?.acme ?? []), "none"]);
const inputs = computed(() => Object.entries(catalog.value?.inputs ?? {}));
const keyIsFile = computed(() => typeof get("spec.ssh.publicKey") !== "string");
</script>

<template>
  <div class="editor">
    <DocHeader kind="Lab" :name="v.metadata?.name" name-hint="the lab's name: its Pulumi stack and its namespace on the Harvesters" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Lab</h3>
      <div class="grid">
        <TextField label="domain" required hint="hosts are <name>.<domain>" v-bind="bind('spec.domain')" />
      </div>
    </section>

    <section>
      <h3>TLS</h3>
      <div class="grid">
        <SelectField label="ACME server" :options="acme" empty="default (letsencrypt)" hint="staging while iterating: Let's Encrypt allows 5 certificates a week per name" v-bind="bind('spec.tls.acme')" />
        <TextField label="email" v-bind="bind('spec.tls.email')" />
        <SecretField label="Cloudflare token" shape="string" :allow-plain="false" hint="DNS-01 challenges" v-bind="bind('spec.tls.cloudflare')" />
      </div>
    </section>

    <section>
      <h3>SSH</h3>
      <div class="grid">
        <TextField label="user" :placeholder="`default ${catalog?.defaults.ssh.user ?? 'lab'}`" hint="the login cloud-init creates on every VM" v-bind="bind('spec.ssh.user')" />
        <TextField v-if="keyIsFile" label="public key file" placeholder="~/.ssh/id_ed25519.pub" v-bind="bind('spec.ssh.publicKey.file')" />
        <TextField v-else label="public key" v-bind="bind('spec.ssh.publicKey')" />
        <SecretField label="private key" shape="string" :allow-plain="false" required v-bind="bind('spec.ssh.privateKey')" />
      </div>
    </section>

    <section>
      <h3>Inputs</h3>
      <p class="muted">For the catalog's secrets and configmaps (Fleet's Helm logins and values files). One that's left out leaves out what needs it.</p>
      <div class="grid">
        <template v-for="[name, shape] in inputs" :key="name">
          <CredentialsField v-if="shape === 'credentials'" :label="name" v-bind="bind(['spec', 'inputs', name])" />
          <SecretField v-else :label="name" shape="string" v-bind="bind(['spec', 'inputs', name])" />
        </template>
      </div>
    </section>

    <details class="advanced">
      <summary>More</summary>
      <div class="grid">
        <ListField label="include" hint="more files or directories of documents, relative to this file" v-bind="bind('spec.include')" />
        <YamlField label="images" hint="OS image sources by profile name: { url } or { file }" v-bind="bind('spec.images')" />
      </div>
    </details>
  </div>
</template>
