import * as pulumi from "@pulumi/pulumi";
import { noProvider, RancherLoginInputs } from "@suse-tmm/utils";
import { RancherApp } from "../resources/app";

export interface RancherUIPluginArgs {
    rancher: RancherLoginInputs;
    chartName: pulumi.Input<string>;
    repoName: pulumi.Input<string>;
    version: pulumi.Input<string>;
}

export class RancherUIPlugin extends pulumi.ComponentResource {
    constructor(name: string, args: RancherUIPluginArgs, opts?: pulumi.ComponentResourceOptions) {
        super("suse-tmm:rancher:UIPlugin", name, {}, opts);

        const myOpts = noProvider({ ...opts, parent: this });
        new RancherApp(`${name}-ui-plugin`, {
            rancher: args.rancher,
            repo: args.repoName,
            chartName: args.chartName,
            chartVersion: args.version,
            namespace: "cattle-ui-plugin-system"
        }, {...opts, parent: this});
    }
}
