import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import { RancherClient, RancherLoginInputs, RancherLoginProviderInputs } from "@suse-tmm/utils";
import got from "got";
import https from "https";

export interface RancherAppInputs {
    rancher: RancherLoginInputs;
    repo: pulumi.Input<string>; // URL of the Rancher app repository
    chartName: pulumi.Input<string>; // Name of the chart to install
    chartVersion: pulumi.Input<string>; // Version of the chart to install
    namespace: pulumi.Input<string>; // Namespace to install the app in
    values?: pulumi.Input<{ [key: string]: any }>; // Values to pass to the chart
}

interface RancherAppProviderInputs {
    rancher: RancherLoginProviderInputs;
    repo: string; // URL of the Rancher app repository
    chartName: string; // Name of the chart to install
    chartVersion: string; // Version of the chart to install
    namespace: string; // Namespace to install the app in
    values?: { [key: string]: any }; // Values to pass to the chart
}

interface RancherAppProviderOutputs extends RancherAppProviderInputs { }

class RancherAppProvider implements dynamic.ResourceProvider<RancherAppProviderInputs, RancherAppProviderOutputs> {
    async create(inputs: RancherAppProviderInputs): Promise<dynamic.CreateResult<RancherAppProviderOutputs>> {
        const { repo, chartName, chartVersion, namespace, values } = inputs;

        const url = `/v1/catalog.cattle.io.clusterrepos/${repo}?action=install`;
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

        pulumi.log.info(`Installing Rancher app: ${chartName} in namespace: ${namespace} from repo: ${repo} on server: ${inputs.rancher.server}`);

        return RancherClient.fromServerConnectionArgs(inputs.rancher).then(client => {
            return client.post(url, body);
        }).then(response => {
            pulumi.log.info(`Successfully installed Rancher app: ${chartName} in namespace: ${namespace}`);
            return {
                id: `${namespace}/${chartName}`,
                outs: inputs as RancherAppProviderOutputs,
            };
        }).catch(err => {
            pulumi.log.error(`Failed to install Rancher app: ${err.message}`);
            throw new Error(`Failed to install Rancher app: ${err.message}`);
        });
    }

    async diff(id: pulumi.ID, olds: RancherAppProviderOutputs, news: RancherAppProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        return {
            changes: olds.rancher.server !== news.rancher.server ||
                olds.rancher.username !== news.rancher.username ||
                olds.rancher.password !== news.rancher.password ||
                // olds.authToken !== news.authToken || // Ignore authToken changes for diff, it may be rotated
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
