import * as pulumi from "@pulumi/pulumi";
import { ClusterRepo } from "@suse-tmm/rancher-crds";

export function installUIPluginRepo(opts?: pulumi.ComponentResourceOptions): ClusterRepo {
    const repo = new ClusterRepo("rancher-ui-plugins", {
        metadata: {
            name: "rancher-ui-plugins",
            annotations: {
                "pulumi.com/waitFor": "condition=Downloaded",
            }
        },
        spec: {
            gitRepo: "https://github.com/rancher/ui-plugin-charts",
            gitBranch: "main"
        }
    }, opts);

    return repo;
}
