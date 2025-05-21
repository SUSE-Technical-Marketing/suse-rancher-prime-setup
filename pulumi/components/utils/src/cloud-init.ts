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

export type PackageArgs = string | string[] | { name: string; version?: string };
export type RunCmdArgs = string | string[];

export interface CloudInitArgs {
    templated?: boolean;

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

    toYaml(): string {
        const userObj = {
            name: this.name,
            sudo: this.sudo,
            password: this.password,
            ssh_authorized_keys: this.sshAuthorizedKeys,
            lock_password: this.lockPassword,
            shell: this.shell,
        };

        return yaml.stringify(userObj, { keepUndefined: false });
    }
}

export class CloudInit {
    templated?: boolean;
    users?: CloudInitUser[];
    packages?: PackageArgs[];
    packageUpdate?: boolean;
    packageUpgrade?: boolean;
    writeFiles?: WriteFileArgs[];
    runcmd?: RunCmdArgs[];

    constructor(args: CloudInitArgs) {
        this.templated = args.templated;
        this.users = args.users?.map((user) => new CloudInitUser(user));
        this.packages = args.packages;
        this.packageUpdate = args.packageUpdate;
        this.packageUpgrade = args.packageUpgrade;
        this.writeFiles = args.writeFiles;
        this.runcmd = args.runcmd;
    }

    toYaml(): string {
        const cloudInitObj: any = {
            users: this.users,
            packages: this.packages,
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
