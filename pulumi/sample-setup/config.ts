import * as pulumi from "@pulumi/pulumi";
import { RancherManagerInstall } from "@suse-tmm/rancher";
import * as versions from "./versions";

export interface HarvesterConfig {
    username: string;
    password: pulumi.Output<string>;
    clusterNetwork: string;
    name: string;
}

export interface VlanConfig {
    enabled: boolean;
    vlanId: string;
    vlanDhcpIpPrefix?: string;
    vlanDhcpGateway?: string;
    vlanDhcpRangeStart?: string;
    vlanDhcpRangeEnd?: string;
    vlanDhcpDnsServers?: string[];
}

export interface VmConfig {
    sshUser: string;
    sshPubKey: string;
    sshPrivKey: pulumi.Output<string>;
    cpu: number;
    memory: string;
    diskSize: string;
    macAddress?: string;
    imageId?: string;
    imageStorageClass: string;
}

export interface CertManagerConfig {
    staging: boolean;
    letsEncryptEmail?: string;
    cloudflareApiKey?: string;
    version: string;
}

export interface LabConfig {
    domain?: string;
    appcoUsername: string;
    appcoPassword: pulumi.Output<string>;
    cloudflareApiToken: pulumi.Output<string>;
    cloudflareAccountId: string;
    sccUsername: string;
    sccPassword: pulumi.Output<string>;
    stackstateLicenseKey: pulumi.Output<string>;
}

export interface RancherConfig {
    adminPassword: pulumi.Output<string>;
    skipBootstrap: boolean;
    vmName: string;
    version: string;
    lizEnabled: boolean;
}

export interface SsoConfig {
    enabled: boolean;
    hostname?: string;
}

export interface Config {
    harvester: HarvesterConfig;
    vm: VmConfig;
    certManager: CertManagerConfig;
    lab: LabConfig;
    rancher: RancherConfig;
    sso: SsoConfig;
    vlan: VlanConfig;
}

export function loadConfig(): Config {
    const harvester = new pulumi.Config("harvester");
    const vm = new pulumi.Config("vm");
    const certManager = new pulumi.Config("cert-manager");
    const lab = new pulumi.Config("lab");
    const rancher = new pulumi.Config("rancher");
    const sso = new pulumi.Config("sso");

    return {
        harvester: {
            username: harvester.require("username"),
            password: harvester.requireSecret("password"),
            clusterNetwork: harvester.get("clusterNetwork") ?? "mgmt",
            name: harvester.get("name") ?? "harvester",
        },
        vm: {
            sshUser: vm.require("sshUser"),
            sshPubKey: vm.require("sshPubKey"),
            sshPrivKey: vm.requireSecret("sshPrivKey"),
            cpu: vm.getNumber("cpu") ?? 2,
            memory: vm.get("memory") ?? "6Gi",
            diskSize: vm.get("diskSize") ?? "100Gi",
            macAddress: vm.get("macAddress"),
            imageId: vm.get("imageId"),
            imageStorageClass: vm.get("imageStorageClass") ?? "longhorn-single",
        },
        certManager: {
            staging: (certManager.get("staging") ?? "true") === "true",
            letsEncryptEmail: certManager.get("letsEncryptEmail"),
            cloudflareApiKey: certManager.get("cloudflareApiKey"),
            version: certManager.get("version") ?? versions.CERT_MANAGER_VERSION,
        },
        lab: {
            domain: lab.get("domain"),
            appcoUsername: lab.require("appcoUsername"),
            appcoPassword: lab.requireSecret("appcoPassword"),
            cloudflareApiToken: lab.requireSecret("cloudflareApiToken"),
            cloudflareAccountId: lab.require("cloudflareAccountId"),
            sccUsername: lab.require("sccUsername"),
            sccPassword: lab.requireSecret("sccPassword"),
            stackstateLicenseKey: lab.requireSecret("stackstateLicenseKey"),
        },
        rancher: {
            adminPassword: RancherManagerInstall.validateAdminPassword(rancher.requireSecret("adminPassword")),
            skipBootstrap: rancher.getBoolean("skipBootstrap") ?? false,
            vmName: rancher.require("vmName"),
            version: rancher.get("version") ?? versions.RANCHER_VERSION,
            lizEnabled: rancher.getBoolean("lizEnabled") ?? false,
        },
        sso: {
            enabled: sso.getBoolean("ssoEnabled") ?? false,
            hostname: sso.get("ssoHostname"),
        },
        vlan: buildVlanConfig(),
    };

    function buildVlanConfig(): VlanConfig {
        const enabled = harvester.getBoolean("vlanEnabled") ?? false;
        if (!enabled) {
            return { enabled: false, vlanId: "" };
        }
        const vlanId = harvester.require("vlanId");
        const vlanPrefix = harvester.get("vlanPrefix") ?? `10.29.${vlanId}`;

        return {
            enabled: true,
            vlanId: vlanId,
        };
    }
}
