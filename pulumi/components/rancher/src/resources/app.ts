import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import { loginToRancher, RancherLoginArgs } from "../functions/login";
import got from "got";

export interface RancherAppInputs {
    rancherServer: pulumi.Input<string>; // Rancher server URL
    authToken: pulumi.Input<string>; // Rancher authentication token
    repo: pulumi.Input<string>; // URL of the Rancher app repository
    chartName: pulumi.Input<string>; // Name of the chart to install
    chartVersion: pulumi.Input<string>; // Version of the chart to install
    namespace: pulumi.Input<string>; // Namespace to install the app in
    values?: pulumi.Input<{ [key: string]: any }>; // Values to pass to the chart
}

interface RancherAppProviderInputs {
    rancherServer: string; // Rancher server URL
    authToken: string; // Rancher authentication token
    repo: string; // URL of the Rancher app repository
    chartName: string; // Name of the chart to install
    chartVersion: string; // Version of the chart to install
    namespace: string; // Namespace to install the app in
    values?: { [key: string]: any }; // Values to pass to the chart
}

interface RancherAppProviderOutputs extends RancherAppProviderInputs { }

class RancherAppProvider implements dynamic.ResourceProvider<RancherAppProviderInputs, RancherAppProviderOutputs> {
    async create(inputs: any): Promise<dynamic.CreateResult<RancherAppProviderOutputs>> {
        const { rancherServer: server, authToken, repo, chartName, chartVersion, namespace, values } = inputs as RancherAppProviderInputs;

        const url = `${server}/v1/catalog.cattle.io.clusterrepos/${repo}?action=install`;
        const body = {
            charts: [{
                chartName,
                version: chartVersion,
                releaseName: chartName,
                annotations: {},
                values: values || {},
            }],
            namespace: namespace
        };

        // 3️⃣ Make the HTTP request to install the app -----------------------------
        const response = await got.post(url, {
            json: body,
            headers: {
                "Authorization": `Bearer ${authToken}`,
            },
            responseType: "json",
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`Failed to install Rancher app: ${response.statusMessage}`);
        }

        return {
            id: `${namespace}/${chartName}`,
            outs: inputs as RancherAppProviderOutputs,
        };
    }

    async diff(id: pulumi.ID, olds: RancherAppProviderOutputs, news: RancherAppProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        return {
            changes: olds.rancherServer !== news.rancherServer ||
                olds.repo !== news.repo ||
                olds.chartName !== news.chartName ||
                olds.chartVersion !== news.chartVersion ||
                olds.namespace !== news.namespace ||
                JSON.stringify(olds.values) !== JSON.stringify(news.values),
        }
    }
}

export class RancherApp extends dynamic.Resource {
    constructor(name: string, args: RancherAppInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new RancherAppProvider(), name, args, opts);
    }
}
