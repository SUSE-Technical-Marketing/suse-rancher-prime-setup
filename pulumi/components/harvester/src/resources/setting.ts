import * as pulumi from "@pulumi/pulumi";
import { RancherClient, RancherLoginInputs, RancherLoginProviderInputs } from "@suse-tmm/utils";

export interface HarvesterSettingInputs {
    harvester: RancherLoginInputs;

    settingName: pulumi.Input<string>;
    settingValue: pulumi.Input<string>;
}

interface HarvesterSettingProviderInputs {
    harvester: RancherLoginProviderInputs;

    settingName: string;
    settingValue: string;
}

interface HarvesterSettingProviderOutputs extends HarvesterSettingProviderInputs { }

// Harvester Settings are similar to Rancher Settings, but managed via the Harvester API.
// They all pre-exist, so we need to update them. However rather than using a PUT, we'll do a PATCH
// to avoid needing to read the existing value first and getting the `resourceVersion`.
class HarvesterSettingProvider implements pulumi.dynamic.ResourceProvider<HarvesterSettingProviderInputs, HarvesterSettingProviderOutputs> {
    async create(inputs: HarvesterSettingProviderInputs): Promise<pulumi.dynamic.CreateResult<HarvesterSettingProviderOutputs>> {
        // let url=`apis/harvesterhci.io/v1beta1/settings/${inputs.settingName}`;
        let url = `v1/harvester/harvesterhci.io.settings/${inputs.settingName}`;
        pulumi.log.info(`Harvester setting URL: ${url}`);
        const body =
            [{
                op: "replace",
                path: "/value",
                value: inputs.settingValue
            }];
        pulumi.log.info(`Setting Harvester setting "${inputs.settingName}" to "${inputs.settingValue}" on server "${inputs.harvester.server}"`);

        return RancherClient.fromServerConnectionArgs(inputs.harvester).then(client => {
            return client.patch(url, body);
        }).then(resp => {
            return {
                id: `${inputs.harvester.server}/${inputs.settingName}`,
                outs: inputs as HarvesterSettingProviderOutputs,
            }
        });
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
