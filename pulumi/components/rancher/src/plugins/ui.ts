import * as pulumi from "@pulumi/pulumi";
import { ClusterRepo } from "@suse-tmm/rancher-crds";
import { noProvider, RancherLogin, RancherLoginInputs } from "@suse-tmm/utils";
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
        const login = new RancherLogin("rancher-login", args.rancher, myOpts);

        new RancherApp("ui-plugin", {
            rancherServer: args.rancher.rancherServer,
            authToken: login.authToken,
            repo: args.repoName,
            insecure: args.rancher.insecure,
            chartName: args.chartName,
            chartVersion: args.version,
            namespace: "cattle-ui-plugin-system"
        }, myOpts);
    }
}
