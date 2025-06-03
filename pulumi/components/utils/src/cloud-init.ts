import * as yaml from "yaml";

export type CloudInitProcessor = (cfg: CloudInitArgs) => CloudInitArgs;

export type CloudInitUserArgs = string | CloudInitUser;
export interface CloudInitUser {
    name: string;
    sudo?: string;
    password: string;
    sshAuthorizedKeys?: string[];
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
        runcmd: []
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
