import * as yaml from "yaml";
import * as pulumi from "@pulumi/pulumi";

export type CloudInitProcessor = (cfg: CloudInitArgs) => CloudInitArgs;

export type CloudInitUserArgs = string | CloudInitUser;
export interface CloudInitUser {
    name: pulumi.Input<string>;
    sudo?: string;
    password: string;
    sshAuthorizedKeys?: pulumi.Input<string>[];
    lockPassword?: boolean;
    shell?: string;
}

export interface WriteFileArgs {
    path: string;
    content: string;
    permissions?: string;
    owner?: string;
    encoding?: string;
}

export interface OutputArgs {
    all?: string;
    console?: boolean;
}

export type PackageArgs = string | string[] | { name: string; version?: string };
export type CmdArgs = string | string[];

// Network configuration interfaces
export interface NetworkSubnet {
    type: "dhcp" | "static" | "dhcp6" | "static6";
    address?: string;
    netmask?: string;
    gateway?: string;
    dns_nameservers?: string[];
    dns_search?: string[];
}

export interface NetworkInterface {
    type: "physical" | "bond" | "bridge" | "vlan";
    name: string;
    mac_address?: string;
    subnets?: NetworkSubnet[];
    // Bond specific
    bond_interfaces?: string[];
    bond_mode?: string;
    bond_miimon?: number;
    // VLAN specific
    vlan_link?: string;
    vlan_id?: number;
    // Bridge specific
    bridge_interfaces?: string[];
    bridge_stp?: boolean;
    bridge_fd?: number;
    bridge_maxwait?: number;
}

export interface NetworkConfig {
    version: 1 | 2;
    config?: NetworkInterface[];
    // Version 2 format
    ethernets?: { [key: string]: any };
    bonds?: { [key: string]: any };
    bridges?: { [key: string]: any };
    vlans?: { [key: string]: any };
}

export interface CloudInitArgs {
    templated: boolean;
    debug: boolean;

    output: OutputArgs;

    users: CloudInitUserArgs[];

    packages: PackageArgs[];

    packageUpdate: boolean;
    packageUpgrade: boolean;

    writeFiles: WriteFileArgs[];
    bootcmd: CmdArgs[];
    runcmd: CmdArgs[];

    network?: NetworkConfig;
}

export function addWriteFiles(args: CloudInitArgs, w: WriteFileArgs): CloudInitArgs {
    args.writeFiles = (args.writeFiles || []).concat(w);
    return args;
}

export function cloudInit(...processors: CloudInitProcessor[]): CloudInitArgs {
    let ci = {
        templated: false,
        debug: false,
        output: {},
        users: [],
        packages: [],
        packageUpdate: false,
        packageUpgrade: false,
        writeFiles: [],
        bootcmd: [],
        runcmd: [],
        network: undefined
    } as CloudInitArgs;
    processors.forEach((processor) => {
        ci = processor(ci);
    });
    return ci;
}

export function renderCloudInit(args: CloudInitArgs): string {
    const cloudInitObj: any = {}
    if (args.debug) {
        cloudInitObj.debug = args.debug;
    }
    if (args.output) {
        cloudInitObj.output = args.output;
    }
    if (args.packageUpdate) {
        cloudInitObj.package_update = args.packageUpdate;
    }
    if (args.packageUpgrade) {
        cloudInitObj.package_upgrade = args.packageUpgrade;
    }
    if (args.writeFiles && args.writeFiles.length > 0) {
        cloudInitObj.write_files = args.writeFiles;
    }
    if (args.bootcmd && args.bootcmd.length > 0) {
        cloudInitObj.bootcmd = args.bootcmd;
    }
    if (args.runcmd && args.runcmd.length > 0) {
        cloudInitObj.runcmd = args.runcmd;
    }
    if (args.packages && args.packages.length > 0) {
        cloudInitObj.packages = args.packages;
    }
    if (args.users && args.users.length > 0) {
        cloudInitObj.users = args.users.map((u) => {
            if (typeof u === "string") {
                return u;
            } else {
                return renderUser(u);
            }
        });
        cloudInitObj.ssh_authorized_keys = args.users.filter((user => typeof user !== "string" && user.sshAuthorizedKeys)).flatMap((user) => (user as CloudInitUser).sshAuthorizedKeys);
    }
    if (args.network) {
        cloudInitObj.network = args.network;
    }

    let cloudinit = yaml.stringify(cloudInitObj, { keepUndefined: false });
    cloudinit = `#cloud-config\n${cloudinit}`;
    if (args.templated) {
        cloudinit = `## template: jinja\n${cloudinit}`;
    }

    return cloudinit;
}

export function renderUser(user: CloudInitUser): { [key: string]: any } {
    const userObj = {
        name: user.name,
        sudo: user.sudo,
        password: user.password,
        ssh_authorized_keys: user.sshAuthorizedKeys,
        lock_password: user.lockPassword,
        shell: user.shell || "/bin/bash",
    };

    return userObj;
}

// Network configuration helper functions
export function createDhcpInterface(name: string, macAddress?: string): NetworkInterface {
    return {
        type: "physical",
        name: name,
        mac_address: macAddress,
        subnets: [{ type: "dhcp" }]
    };
}

export function createStaticInterface(
    name: string,
    address: string,
    netmask: string,
    gateway?: string,
    dnsServers?: string[],
    macAddress?: string
): NetworkInterface {
    return {
        type: "physical",
        name: name,
        mac_address: macAddress,
        subnets: [{
            type: "static",
            address: address,
            netmask: netmask,
            gateway: gateway,
            dns_nameservers: dnsServers
        }]
    };
}

export function createNetworkConfig(interfaces: NetworkInterface[], version: 1 | 2 = 1): NetworkConfig {
    return {
        version: version,
        config: interfaces
    };
}


