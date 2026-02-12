import * as pulumi from "@pulumi/pulumi";
import { HelmApp } from "./helmapp";

interface CloudflareIngressArgs {
    apiToken: pulumi.Input<string>;
    accountId: pulumi.Input<string>;
    tunnelName: pulumi.Input<string>;
}

export function installCloudflareIngress(args: CloudflareIngressArgs, opts?: pulumi.ComponentResourceOptions): HelmApp {
    return new HelmApp("cloudflare-tunnel-ingress-controller", {
        chart: "cloudflare-tunnel-ingress-controller",
        repository: "https://helm.strrl.dev",
        values: {
            cloudflare: {
                apiToken: args.apiToken,
                accountId: args.accountId,
                tunnelName: args.tunnelName,
            }
        }
    }, opts);
}
