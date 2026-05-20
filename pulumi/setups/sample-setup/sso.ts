import * as pulumi from "@pulumi/pulumi";
import { Authentik, SsoOpts } from "@suse-tmm/common";
import { AUTHENTIK_VERSION } from "./versions";
import { SsoConfig } from "./config";

export function setupSso(sso: SsoConfig, opts?: pulumi.ComponentResourceOptions) {
    if (sso.enabled && sso.hostname) {
        Authentik(AUTHENTIK_VERSION, { hostname: sso.hostname }, opts);
    }
}