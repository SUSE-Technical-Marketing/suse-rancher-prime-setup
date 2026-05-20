import * as pulumi from "@pulumi/pulumi";
import { management } from "../../generated";

export interface RancherSettingInputs {
    settingName: string;
    settingValue: pulumi.Input<string>;
}

export class RancherSetting extends pulumi.ComponentResource {
    public readonly setting: management.v3.SettingPatch;

    constructor(name: string, args: RancherSettingInputs, opts: pulumi.ComponentResourceOptions) {
        super("suse-tmm:rancher:Setting", name, {}, opts);

        this.setting = new management.v3.SettingPatch(name, {
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
