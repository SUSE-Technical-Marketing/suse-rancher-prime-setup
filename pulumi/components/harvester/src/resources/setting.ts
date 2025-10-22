import * as pulumi from "@pulumi/pulumi";
import got from "got";
import https from "https";

export interface HarvesterSettingInputs {
    server: pulumi.Input<string>;
    authToken: pulumi.Input<string>;
    insecure?: pulumi.Input<boolean>;

    settingName: pulumi.Input<string>;
    settingValue: pulumi.Input<string>;
}

interface HarvesterSettingProviderInputs {
    server: string;
    authToken: string;
    insecure?: boolean;

    settingName: string;
    settingValue: string;
}

interface HarvesterSettingProviderOutputs extends HarvesterSettingProviderInputs { }

// Harvester Settings are similar to Rancher Settings, but managed via the Harvester API.
// They all pre-exist, so we need to update them. However rather than using a PUT, we'll do a PATCH
// to avoid needing to read the existing value first and getting the `resourceVersion`.
class HarvesterSettingProvider implements pulumi.dynamic.ResourceProvider<HarvesterSettingProviderInputs, HarvesterSettingProviderOutputs> {
    async create(inputs: HarvesterSettingProviderInputs): Promise<pulumi.dynamic.CreateResult<HarvesterSettingProviderOutputs>> {
        let url = `${inputs.server}/apis/harvesterhci.io/v1beta1/settings/${inputs.settingName}`;
        pulumi.log.info(`Harvester setting URL: ${url}`);
        const body = [
            {
                op: "replace",
                path: "/value",
                value: inputs.settingValue
            }
        ];

        pulumi.log.info(`Setting Harvester setting "${inputs.settingName}" to "${inputs.settingValue}" on server "${inputs.server}"`);

        const agent = new https.Agent({
            rejectUnauthorized: !inputs.insecure, // Allow self-signed certificates if insecure is true
        });

        const resp = await got.patch(url, {
            agent: { https: agent },
            
            json: body,
            headers: {
                Authorization: `Bearer ${inputs.authToken}`,
                "Content-Type": "application/json-patch+json",
            },
            responseType: "json",
            timeout: { request: 10000 }, // 10 seconds timeout
            retry: { limit: 2 }, // Retry on failure
        });

        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw new Error(`Failed to set Harvester setting ${inputs.settingName}: ${resp.statusMessage}`);
        }

        return {
            id: `${inputs.server}/${inputs.settingName}`,
            outs: inputs as HarvesterSettingProviderOutputs,
        };
    }

    async delete(): Promise<void> {
        // No specific cleanup needed for setting
    }

    async update(id: pulumi.ID, olds: HarvesterSettingProviderOutputs, news: HarvesterSettingProviderInputs): Promise<pulumi.dynamic.UpdateResult<HarvesterSettingProviderOutputs>> {
        return this.create(news);
    }

    async diff(id: pulumi.ID, olds: HarvesterSettingProviderOutputs, news: HarvesterSettingProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        return { changes: olds.settingValue !== news.settingValue, replaces: ["settingValue"] };
    }
}

export class HarvesterSetting extends pulumi.dynamic.Resource {
    constructor(name: string, inputs: HarvesterSettingInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new HarvesterSettingProvider(), name, inputs, opts);
    }
}
