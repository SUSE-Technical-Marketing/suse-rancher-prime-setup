import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

export interface HarvesterAddonArgs {
    /** The Harvester's name, which is also its kubeconfig context. */
    harvester: string;
    name: string;
    namespace: string;
    repo: string;
    chart: string;
    version: pulumi.Input<string>;
    valuesContent?: pulumi.Input<string>;
    labels?: Record<string, string>;
}

interface Inputs {
    harvester: string;
    name: string;
    namespace: string;
    repo: string;
    chart: string;
    version: string;
    valuesContent?: string;
    labels?: Record<string, string>;
}

const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A Harvester add-on, removed the way Harvester expects: disable it, wait until its HelmChart is
 * gone (the uninstall ran), then delete it. Deleting an enabled Add-on object directly makes the
 * uninstall job lose its service account to garbage collection, leaving the chart installed.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const base = `/apis/harvesterhci.io/v1beta1/namespaces/${inputs.namespace}/addons`;
        const res = await kubeRequest({ context: inputs.harvester }, "POST", base, {
            apiVersion: "harvesterhci.io/v1beta1",
            kind: "Addon",
            metadata: { name: inputs.name, namespace: inputs.namespace, labels: inputs.labels ?? {} },
            spec: { enabled: true, repo: inputs.repo, chart: inputs.chart, version: inputs.version, valuesContent: inputs.valuesContent ?? "" },
        });
        if (res.status === 409) throw new Error(`add-on ${inputs.namespace}/${inputs.name} already exists on ${inputs.harvester}; is another lab or a manual install using it?`);
        if (res.status !== 201 && res.status !== 200) throw new Error(`creating add-on ${inputs.name} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        await waitCompleted(inputs);
        return { id: `${inputs.harvester}/${inputs.namespace}/${inputs.name}`, outs: inputs };
    },

    async diff(_id: string, olds: Inputs, news: Inputs) {
        const replaces = (["harvester", "name", "namespace"] as const).filter(k => olds[k] !== news[k]);
        const changes = replaces.length > 0 || JSON.stringify(olds) !== JSON.stringify(news);
        return { changes, replaces, deleteBeforeReplace: true };
    },

    async update(_id: string, _olds: Inputs, news: Inputs) {
        const res = await kubeRequest({ context: news.harvester }, "PATCH", `/apis/harvesterhci.io/v1beta1/namespaces/${news.namespace}/addons/${news.name}`, {
            metadata: { labels: news.labels ?? {} },
            spec: { enabled: true, repo: news.repo, chart: news.chart, version: news.version, valuesContent: news.valuesContent ?? "" },
        });
        if (res.status !== 200) throw new Error(`updating add-on ${news.name} failed: HTTP ${res.status}`);
        await waitCompleted(news);
        return { outs: news };
    },

    async delete(_id: string, props: Inputs) {
        const addon = `/apis/harvesterhci.io/v1beta1/namespaces/${props.namespace}/addons/${props.name}`;
        const chart = `/apis/helm.cattle.io/v1/namespaces/${props.namespace}/helmcharts/${props.name}`;
        const disabled = await kubeRequest({ context: props.harvester }, "PATCH", addon, { spec: { enabled: false } });
        if (disabled.status === 404) return;
        if (disabled.status !== 200) throw new Error(`disabling add-on ${props.name} failed: HTTP ${disabled.status}`);
        await poll(`add-on ${props.name} to uninstall`, async () => (await kubeRequest({ context: props.harvester }, "GET", chart)).status === 404);
        const deleted = await kubeRequest({ context: props.harvester }, "DELETE", addon);
        if (deleted.status !== 200 && deleted.status !== 202 && deleted.status !== 404) throw new Error(`deleting add-on ${props.name} failed: HTTP ${deleted.status}`);
        await poll(`add-on ${props.name} to be deleted`, async () => (await kubeRequest({ context: props.harvester }, "GET", addon)).status === 404);
    },
};

async function waitCompleted(inputs: Inputs): Promise<void> {
    const path = `/apis/harvesterhci.io/v1beta1/namespaces/${inputs.namespace}/addons/${inputs.name}`;
    await poll(`add-on ${inputs.name} to deploy`, async () => {
        const res = await kubeRequest({ context: inputs.harvester }, "GET", path);
        const conditions: any[] = res.body?.status?.conditions ?? [];
        return conditions.some(c => c.type === "Completed" && c.status === "True");
    });
}

async function poll(what: string, done: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await done().catch(() => false)) return;
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`timed out waiting for ${what}`);
}

export class HarvesterAddon extends pulumi.dynamic.Resource {
    constructor(name: string, args: HarvesterAddonArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, args, opts, "lab", "HarvesterAddon");
    }
}
