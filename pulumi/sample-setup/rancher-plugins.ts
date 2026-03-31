import * as pulumi from "@pulumi/pulumi";
import { installUIPluginRepo, defaultUIPluginRepos, RancherUIPlugin } from "@suse-tmm/rancher";
import { RancherLoginInputs } from "@suse-tmm/utils";
import { RancherSetting } from "@suse-tmm/rancher/src/resources/setting";
import { RancherManagerInstall } from "@suse-tmm/rancher";
import * as versions from "./versions";

export function installPlugins(
    rancher: RancherLoginInputs,
    opts: pulumi.ResourceOptions,
): RancherUIPlugin[] {
    const repos = defaultUIPluginRepos(opts);

    return [
        { name: "harvester", repoName: "rancher-ui-plugins", version: versions.HARVESTER_UIPLUGIN_VERSION },
        { name: "virtual-clusters", repoName: "virtual-clusters", version: versions.VIRTUAL_CLUSTERS_UIPLUGIN_VERSION },
        { name: "kubewarden", repoName: "rancher-ui-plugins", version: versions.KUBEWARDEN_UIPLUGIN_VERSION },
        { name: "sbomscanner-ui-ext", repoName: "security-ui", version: versions.SBOMSCANNER_UIPLUGIN_VERSION },
    ].map(plugin =>
        new RancherUIPlugin(plugin.name, {
            chartName: plugin.name,
            rancher: rancher,
            repoName: repos[plugin.repoName].metadata.name,
            version: plugin.version,
        }, opts)
    );
}

export function installLizExtension(
    rancher: RancherLoginInputs,
    rancherManager: RancherManagerInstall,
    opts: pulumi.ResourceOptions,
) {
    const lizRepo = installUIPluginRepo("rancher-ai-liz", {
        gitRepo: "https://github.com/torchiaf/rancher-ai-ui",
        gitBranch: "gh-pages",
    }, opts);

    new RancherUIPlugin("rancher-ai-ui", {
        chartName: "rancher-ai-ui",
        rancher: rancher,
        repoName: lizRepo.metadata.name,
        version: "0.1.40",
    });

    [
        { name: "ui-index", value: "https://releases.rancher.com/ui/ai-extension-shell-api-compatible-dev/index.html" },
        { name: "ui-dashboard-index", value: "https://releases.rancher.com/dashboard/ai-extension-shell-api-compatible-dev/index.html" },
        { name: "ui-offline-preferred", value: "false" },
    ].forEach(setting =>
        new RancherSetting(setting.name, {
            rancher: rancher,
            settingName: setting.name,
            settingValue: setting.value,
        }, {
            dependsOn: [rancherManager],
        })
    );
}
