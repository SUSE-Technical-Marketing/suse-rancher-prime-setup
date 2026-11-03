<script setup lang="ts">
import { computed, provide } from "vue";
import type { SettingSchema } from "../api";
import { useDoc } from "../doc";
import { FORM_CONTEXT } from "../form";
import { catalog } from "../store";
import CredentialsField from "./CredentialsField.vue";
import DocHeader from "./DocHeader.vue";
import SchemaForm from "./SchemaForm.vue";
import SecretField from "./SecretField.vue";
import TextField from "./TextField.vue";

// The Lab document: its fields from its schema (SchemaForm); the inputs, which the catalog's
// secrets and configmaps name, and the SSH key, a text or a file, are this editor's own.
const props = defineProps<{ index: number }>();
const { v, bind, set, get } = useDoc(() => props.index);
const schema = computed<SettingSchema>(() => catalog.value?.documentForms.Lab ?? {});
const part = (key: string) => schema.value.properties?.[key] ?? {};
const inputs = computed(() => Object.entries(catalog.value?.inputs ?? {}));
const keyIsFile = computed(() => typeof get("spec.ssh.publicKey") !== "string");

provide(FORM_CONTEXT, () => ({
  options: { acme: [...(catalog.value?.acme ?? []), "none"] },
  vars: { defaults: catalog.value?.defaults },
}));
</script>

<template>
  <div class="editor">
    <DocHeader kind="Lab" :name="v.metadata?.name" name-hint="the lab's name: its Pulumi stack and its namespace on the Harvesters" @name="x => set('metadata.name', x)" />

    <section>
      <h3>Lab</h3>
      <SchemaForm :index="index" :schema="schema" />
    </section>

    <section>
      <h3>TLS</h3>
      <SchemaForm :index="index" :schema="part('tls')" :at="['spec', 'tls']" />
    </section>

    <section>
      <h3>SSH</h3>
      <SchemaForm :index="index" :schema="part('ssh')" :at="['spec', 'ssh']">
        <template #publicKey="field">
          <TextField v-if="keyIsFile" label="public key file" placeholder="~/.ssh/id_ed25519.pub" v-bind="bind('spec.ssh.publicKey.file')" />
          <TextField v-else label="public key" v-bind="field" />
        </template>
      </SchemaForm>
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

    <section>
      <h3>Vars</h3>
      <p class="muted">Your own values, any keys: the lab's documents, profiles and cloud-init refer to them as <code v-pre>{{ lab.vars.team }}</code>.</p>
      <SchemaForm :index="index" :schema="schema" section="vars" />
    </section>

    <details class="advanced">
      <summary>More</summary>
      <SchemaForm :index="index" :schema="schema" section="advanced" />
    </details>
  </div>
</template>
