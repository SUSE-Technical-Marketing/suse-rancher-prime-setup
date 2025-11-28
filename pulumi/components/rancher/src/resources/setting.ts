import * as pulumi from "@pulumi/pulumi";
import { RancherClient, RancherLoginInputs, RancherLoginProviderInputs } from "@suse-tmm/utils";

export interface RancherSettingInputs {
    rancher: RancherLoginInputs;

    groupName?: pulumi.Input<"harvesterhci.io">; // Optional, not set for Rancher settings, but needed for Harvester settings

    settingName: pulumi.Input<string>;
    settingValue: pulumi.Input<string>;
}

interface RancherSettingProviderInputs {
    rancher: RancherLoginProviderInputs;

    groupName?: "harvesterhci.io"; // Optional, not set for Rancher settings, but needed for Harvester settings
    settingName: string;
    settingValue: string;
}

interface RancherSettingProviderOutputs extends RancherSettingProviderInputs { }

class RancherSettingProvider implements pulumi.dynamic.ResourceProvider<RancherSettingProviderInputs, RancherSettingProviderOutputs> {
    async create(inputs: RancherSettingProviderInputs): Promise<pulumi.dynamic.CreateResult<RancherSettingProviderOutputs>> {
        let url = `v3/settings/${inputs.settingName}`;
        if (inputs.groupName) {
            url = `apis/${inputs.groupName}/v1/settings/${inputs.settingName}`;
        }

        const body = {
            metadata: {
                name: inputs.settingName,
            },
            value: inputs.settingValue
        };

        pulumi.log.info(`Setting Rancher setting "${inputs.settingName}" to "${inputs.settingValue}" on server "${inputs.rancher.server}"`);

        return RancherClient.login(inputs.rancher).then(client => {
            return client.patch(url, body);
        }).then(resp => {
            return {
                id: `${inputs.rancher.server}/${inputs.settingName}`,
                outs: inputs as RancherSettingProviderOutputs,
            }
        });
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
