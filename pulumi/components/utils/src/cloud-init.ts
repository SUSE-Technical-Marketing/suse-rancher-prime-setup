import { output, Output } from "@pulumi/pulumi";
import * as yaml from "yaml";

export interface CloudInitUserArgs {
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
export type RunCmdArgs = string | string[];

export interface CloudInitArgs {
    templated?: boolean;
    debug?: boolean;

    output?: OutputArgs;

    users?: CloudInitUserArgs[];

    packages?: PackageArgs[];

    packageUpdate?: boolean;
    packageUpgrade?: boolean;

    writeFiles?: WriteFileArgs[];

    runcmd?: RunCmdArgs[];
}

export class CloudInitUser {
    name: string;
    sudo?: string;
    password: string;
    sshAuthorizedKeys?: string[];
    lockPassword?: boolean;
    shell?: string;
    constructor(args: CloudInitUserArgs) {
        this.name = args.name;
        this.sudo = args.sudo ;
        this.password = args.password;
        this.sshAuthorizedKeys = args.sshAuthorizedKeys;
        this.lockPassword = args.lockPassword;
        this.shell = args.shell || "/bin/bash";
    }

    toYaml(): any {
        const userObj = {
            name: this.name,
            sudo: this.sudo,
            password: this.password,
            ssh_authorized_keys: this.sshAuthorizedKeys,
            lock_password: this.lockPassword,
            shell: this.shell,
        };

        return userObj;
    }
}

export class CloudInit {
    templated?: boolean;
    debug?: boolean;
    users?: CloudInitUser[];
    packages?: PackageArgs[];
    packageUpdate?: boolean;
    packageUpgrade?: boolean;
    writeFiles?: WriteFileArgs[];
    runcmd?: RunCmdArgs[];
    output?: OutputArgs;

    constructor(args: CloudInitArgs) {
        this.templated = args.templated;
        this.debug = args.debug;
        this.users = args.users?.map((user) => new CloudInitUser(user));
        this.packages = args.packages;
        this.packageUpdate = args.packageUpdate;
        this.packageUpgrade = args.packageUpgrade;
        this.writeFiles = args.writeFiles;
        this.runcmd = args.runcmd;
        this.output = args.output;
    }

    toYaml(): string {
        const cloudInitObj: any = {
            debug: this.debug,
            output: this.output,
            users: (["default"] as (CloudInitUser|string)[]).concat(this.users?.map((user) => user.toYaml()) || []),
            packages: this.packages,
            ssh_authorized_keys: this.users?.flatMap((user) => user.sshAuthorizedKeys),
            package_update: this.packageUpdate,
            package_upgrade: this.packageUpgrade,
            write_files: this.writeFiles,
            runcmd: this.runcmd,
        };

        let cloudinit = yaml.stringify(cloudInitObj, { keepUndefined: false });
        cloudinit = `#cloud-config\n${cloudinit}`;
        if (this.templated) {
            cloudinit = `## template: jinja\n${cloudinit}`;
        }

        return cloudinit;
    }
}
