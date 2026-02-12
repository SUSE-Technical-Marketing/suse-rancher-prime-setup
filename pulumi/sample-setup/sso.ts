import * as pulumi from "@pulumi/pulumi";
import { Authentik, SsoOpts } from "@suse-tmm/common";
import { AUTHENTIK_VERSION } from "./versions";

export function setupSso(config: pulumi.Config, opts?: pulumi.ComponentResourceOptions) {
    const ssoEnabled = config.getBoolean("ssoEnabled") ?? false;

    if (ssoEnabled) {
        // Install Authentik to local cluster
        Authentik(AUTHENTIK_VERSION, { hostname: config.require("ssoHostname") }, opts);

    }
}