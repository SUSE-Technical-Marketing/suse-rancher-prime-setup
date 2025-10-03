import * as pulumi from "@pulumi/pulumi";
import got from "got";
import https from "https";

export interface RancherSettingInputs {
    rancherServer: pulumi.Input<string>;
    authToken: pulumi.Input<string>;
    insecure?: pulumi.Input<boolean>;

    groupName?: pulumi.Input<"harvesterhci.io">; // Optional, not set for Rancher settings, but needed for Harvester settings

    settingName: pulumi.Input<string>;
    settingValue: pulumi.Input<string>;
}

interface RancherSettingProviderInputs {
    rancherServer: string;
    authToken: string;
    insecure?: boolean;

    groupName?: "harvesterhci.io"; // Optional, not set for Rancher settings, but needed for Harvester settings
    settingName: string;
    settingValue: string;
}

interface RancherSettingProviderOutputs extends RancherSettingProviderInputs { }

class RancherSettingProvider implements pulumi.dynamic.ResourceProvider<RancherSettingProviderInputs, RancherSettingProviderOutputs> {
    async create(inputs: RancherSettingProviderInputs): Promise<pulumi.dynamic.CreateResult<RancherSettingProviderOutputs>> {
        let url = `${inputs.rancherServer}/v3/settings/${inputs.settingName}`;
        if (inputs.groupName) {
            url = `${inputs.rancherServer}/apis/${inputs.groupName}/v1/settings/${inputs.settingName}`;
        }

        const body = {
            metadata: {
                name: inputs.settingName,
            },
            value: inputs.settingValue
        };

        pulumi.log.info(`Setting Rancher setting "${inputs.settingName}" to "${inputs.settingValue}" on server "${inputs.rancherServer}"`);

        const agent = new https.Agent({
            rejectUnauthorized: !inputs.insecure, // Allow self-signed certificates if insecure is true
        });

        const resp = await got.put(url, {
            agent: { https: agent },
            json: body,
            headers: {
                Authorization: `Bearer ${inputs.authToken}`,
            },
            responseType: "json",
            timeout: { request: 10000 }, // 10 seconds timeout
            retry: { limit: 2 }, // Retry on failure
        });

        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            throw new Error(`Failed to set Rancher setting ${inputs.settingName}: ${resp.statusMessage}`);
        }

        return {
            id: `${inputs.rancherServer}/${inputs.settingName}`,
            outs: inputs as RancherSettingProviderOutputs,
        };
    }

    async delete(): Promise<void> {
        // No specific cleanup needed for setting
    }

    async update(id: pulumi.ID, olds: RancherSettingProviderOutputs, news: RancherSettingProviderInputs): Promise<pulumi.dynamic.UpdateResult<RancherSettingProviderOutputs>> {
        return this.create(news);
    }

    async diff(id: pulumi.ID, olds: RancherSettingProviderOutputs, news: RancherSettingProviderInputs): Promise<pulumi.dynamic.DiffResult> {
        return { changes: olds.settingValue !== news.settingValue, replaces: ["settingValue"] };
    }
}

export class RancherSetting extends pulumi.dynamic.Resource {
    constructor(name: string, inputs: RancherSettingInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new RancherSettingProvider(), name, inputs, opts);
    }
}
