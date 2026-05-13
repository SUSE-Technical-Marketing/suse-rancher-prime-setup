import * as pulumi from "@pulumi/pulumi";

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

export interface LabConfig {
    domain?: string;
    sshUser: string;
    sshPubKey: string;
}

export interface Config {
    harvester: HarvesterConfig;
    lab: LabConfig;
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
        lab: {
            domain: lab.get("domain"),
            sshUser: lab.require("sshUser"),
            sshPubKey: lab.require("sshPubKey"),
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
