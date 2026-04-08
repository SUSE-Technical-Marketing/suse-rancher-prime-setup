import * as pulumi from "@pulumi/pulumi";
import { installUIPluginRepo, defaultUIPluginRepos, RancherUIPlugin } from "@suse-tmm/rancher";
import { RancherLoginInputs } from "@suse-tmm/utils";
import { RancherSetting } from "@suse-tmm/rancher/src/resources/setting";
import { RancherManagerInstall } from "@suse-tmm/rancher";
import * as versions from "./versions";
import { HelmApp } from "@suse-tmm/common";

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
    new HelmApp("rancher-ai-agent", {
        namespace: "cattle-ai-agent-system",
        createNamespace: true,
        chart: "oci://registry.suse.com/rancher/charts/rancher-ai-agent",
    }, { ...opts, dependsOn: [rancherManager] });

    new RancherUIPlugin("rancher-ai-ui", {
        chartName: "rancher-ai-ui",
        rancher: rancher,
        repoName: "rancher-ui-plugins",
        version: versions.AI_UIPLUGIN_VERSION,
    }, { ...opts, dependsOn: [rancherManager] });

    // [
    //     { name: "ui-index", value: "https://releases.rancher.com/ui/ai-extension-shell-api-compatible-dev/index.html" },
    //     { name: "ui-dashboard-index", value: "https://releases.rancher.com/dashboard/ai-extension-shell-api-compatible-dev/index.html" },
    //     { name: "ui-offline-preferred", value: "false" },
    // ].forEach(setting =>
    //     new RancherSetting(setting.name, {
    //         settingName: setting.name,
    //         settingValue: setting.value,
    //     }, {
    //         ...opts,
    //         dependsOn: [rancherManager],
    //     })
    // );
}
