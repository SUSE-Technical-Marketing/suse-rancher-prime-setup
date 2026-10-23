/**
 * Default versions of everything the lab installs. A lab file overrides any of them under
 * `versions:` with the same key; a profile's own `version` setting wins over both.
 */
export const DEFAULT_VERSIONS: Record<string, string> = {
    "harvester-dns-controller": "0.3.0",
    "harvester-cloud-provider": "0.2.16",
    k3s: "v1.36.4+k3s1",
    // Same Kubernetes as k3s above; check https://update.rke2.io/v1-release/channels when bumping.
    rke2: "v1.36.4+rke2r1",
    "cert-manager": "v1.20.2",
    sprouter: "0.11.1",
    outrider: "0.5.0",
    traefik: "41.2.0",
    // https://github.com/kubernetes-sigs/gateway-api/releases
    "gateway-api": "v1.6.2",
    rancher: "v2.15.2",
    // UI plugins, by chart name in rancher/ui-plugin-charts
    "plugin/harvester": "1.8.2",
    "plugin/virtual-clusters": "1.2.1",
    "plugin/kubewarden": "4.2.1",
    "plugin/vulnerability-scanner": "0.9.0",
    "plugin/rancher-ai-ui": "1.1.0",
    // helm show all oci://registry.suse.com/rancher/charts/rancher-ai-agent
    "rancher-ai-agent": "110.0.0+up1.1.0",
};

/** Plugins installed when a `rancher` profile doesn't list any (the `pulumi/` setup's set). */
export const DEFAULT_PLUGINS = ["harvester", "virtual-clusters", "kubewarden", "vulnerability-scanner", "rancher-ai-ui"];

/** The vm-dhcp-controller add-on follows the Harvester release it runs on. */
const DHCP_CONTROLLER_BY_HARVESTER: Record<string, string> = {
    "1.8": "1.8.2",
    "1.9": "1.9.0",
};

export function dhcpControllerVersion(harvesterVersion: string | undefined, overrides: Record<string, string>): string {
    if (overrides["harvester-vm-dhcp-controller"]) return overrides["harvester-vm-dhcp-controller"];
    const minor = /^v?(\d+\.\d+)/.exec(harvesterVersion ?? "")?.[1];
    const known = Object.keys(DHCP_CONTROLLER_BY_HARVESTER).sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
    // Unknown (newer) Harvester: take the newest version we know.
    return DHCP_CONTROLLER_BY_HARVESTER[minor ?? ""] ?? DHCP_CONTROLLER_BY_HARVESTER[known[known.length - 1]];
}

export function version(key: string, overrides: Record<string, string>, own?: string): string {
    const v = own ?? overrides[key] ?? DEFAULT_VERSIONS[key];
    if (!v) throw new Error(`no version known for ${key}; set versions.${key} in the lab file`);
    return v;
}
