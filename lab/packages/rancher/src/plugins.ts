import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { catalog } from "@lab/crds";
import { rancherLogin, rancherRequest } from "@lab/kube";
import { helmApp, onCluster, withCluster } from "@lab/kubernetes";
import { RancherAccess } from "./server";

interface AppInputs {
    url: string;
    insecure: boolean;
    password: string;
    repo: string;
    chart: string;
    version: string;
    namespace: string;
}

async function token(inputs: AppInputs): Promise<string> {
    const t = await rancherLogin({ url: inputs.url, insecure: inputs.insecure }, "admin", inputs.password);
    if (!t) throw new Error(`Rancher at ${inputs.url} rejected the admin password`);
    return t;
}

/**
 * A chart installed through Rancher's app catalog (how UI plugins are installed). Rancher runs the
 * install as a Helm operation; this waits until the app shows up as deployed.
 */
const appProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: AppInputs) {
        const endpoint = { url: inputs.url, insecure: inputs.insecure };
        const t = await token(inputs);
        const res = await rancherRequest(endpoint, "POST", `/v1/catalog.cattle.io.clusterrepos/${inputs.repo}?action=install`, {
            charts: [{ chartName: inputs.chart, version: inputs.version, releaseName: inputs.chart, annotations: {}, values: {} }],
            namespace: inputs.namespace,
        }, t);
        if (res.status < 200 || res.status >= 300) throw new Error(`installing ${inputs.chart} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            const app = await rancherRequest(endpoint, "GET", `/v1/catalog.cattle.io.apps/${inputs.namespace}/${inputs.chart}`, undefined, t);
            const status = app.body?.spec?.info?.status ?? app.body?.status?.summary?.state;
            if (app.status === 200 && status === "deployed") return { id: `${inputs.namespace}/${inputs.chart}`, outs: inputs };
            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error(`timed out waiting for ${inputs.chart} to be deployed`);
    },
    async diff(_id: string, olds: AppInputs, news: AppInputs) {
        const changes = (["url", "repo", "chart", "version", "namespace"] as const).some(k => olds[k] !== news[k]);
        return { changes, replaces: changes ? ["version"] : [], deleteBeforeReplace: true };
    },
    async delete(_id: string, props: AppInputs) {
        const endpoint = { url: props.url, insecure: props.insecure };
        const t = await rancherLogin(endpoint, "admin", props.password).catch(() => undefined);
        if (!t) return; // Rancher is gone already (the lab is being destroyed)
        await rancherRequest(endpoint, "POST", `/v1/catalog.cattle.io.apps/${props.namespace}/${props.chart}?action=uninstall`, {}, t);
    },
};

class RancherApp extends pulumi.dynamic.Resource {
    constructor(name: string, args: { [K in keyof AppInputs]: pulumi.Input<AppInputs[K]> }, opts?: pulumi.CustomResourceOptions) {
        super(appProvider, name, { ...args, password: pulumi.secret(args.password) }, opts, "lab", "RancherApp");
    }
}

export interface UiPluginsArgs {
    rancher: RancherAccess;
    /** Plugin name -> chart version. */
    plugins: Record<string, string>;
}

/** The rancher/ui-plugin-charts repository and the plugins installed from it. */
export class UiPlugins extends pulumi.ComponentResource {
    constructor(name: string, args: UiPluginsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:UiPlugins", name, {}, opts);
        const { rancher } = args;
        const repo = new catalog.v1.ClusterRepo(`${name}/repo`, {
            metadata: { name: "rancher-ui-plugins", annotations: { "pulumi.com/waitFor": "condition=Downloaded" } },
            spec: { gitRepo: "https://github.com/rancher/ui-plugin-charts", gitBranch: "main" },
        }, { ...onCluster(rancher.cluster, this), provider: rancher.provider, dependsOn: rancher.ready });

        for (const [plugin, version] of Object.entries(args.plugins)) {
            new RancherApp(`${name}/${plugin}`, {
                url: rancher.url,
                insecure: rancher.insecure,
                password: rancher.password,
                repo: "rancher-ui-plugins",
                chart: plugin,
                version,
                namespace: "cattle-ui-plugin-system",
            }, withCluster(rancher.cluster, this, { dependsOn: [repo] }));
        }
        this.registerOutputs({});
    }
}

/** Liz, Rancher's AI assistant: the agent chart (its UI is the `rancher-ai-ui` plugin). */
export function liz(name: string, rancher: RancherAccess, version: string, parent: pulumi.Resource): k8s.helm.v3.Release {
    return helmApp(name, {
        chart: "oci://registry.suse.com/rancher/charts/rancher-ai-agent",
        version,
        namespace: "cattle-ai-agent-system",
    }, { ...onCluster(rancher.cluster, parent), provider: rancher.provider, dependsOn: rancher.ready });
}
