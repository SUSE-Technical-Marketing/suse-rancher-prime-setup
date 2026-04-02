import * as pulumi from "@pulumi/pulumi";
import { management } from "@suse-tmm/rancher-crds";

export interface RancherSettingInputs {
    settingName: string;
    settingValue: pulumi.Input<string>;
}

export class RancherSetting extends pulumi.ComponentResource {
    public readonly setting: management.SettingPatch;

    constructor(name: string, args: RancherSettingInputs, opts: pulumi.ComponentResourceOptions) {
        super("suse-tmm:rancher:Setting", name, {}, opts);

        this.setting = new management.SettingPatch(name, {
            metadata: {
                name: args.settingName,
                annotations: {
                    "pulumi.com/patchForce": "true",
                },
            },

            value: args.settingValue,
        }, {
            ...opts,
            parent: this,
            retainOnDelete: true,
        });

        this.registerOutputs({ setting: this.setting });
    }
}
