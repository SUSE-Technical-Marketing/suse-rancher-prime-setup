import * as yaml from "yaml";
import { cloudInit, CloudInitUser, CloudInitUserArgs, renderCloudInit, renderUser } from "../src/cloud-init";
import { assert } from "chai";
import { describe, it } from "mocha";
import { NewUser, Packages, PackageUpdate, PackageUpgrade, WriteFile } from "../src/processors";

describe("CloudInitUser", () => {

    it("should generate correct YAML", () => {
        const args: CloudInitUserArgs = {
            name: "bob",
            password: "pw",
            sshAuthorizedKeys: ["key1", "key2"],
            lockPassword: false,
            shell: "/bin/sh"
        };
        const parsed = renderUser(args);
        assert.equal(parsed.name, "bob");
        assert.equal(parsed.password, "pw");
        assert.deepEqual(parsed.ssh_authorized_keys, ["key1", "key2"]);
        assert.equal(parsed.lock_password, false);
        assert.equal(parsed.shell, "/bin/sh");
    });

    it("should have undefined fields", () => {
        const args: CloudInitUserArgs = {
            name: "eve",
            password: "pw"
        };
        const parsed = renderUser(args);
        assert.equal(parsed.name, "eve");
        assert.equal(parsed.password, "pw");
        assert.equal(parsed.shell, "/bin/bash");
        assert.isUndefined(parsed.sudo);
        assert.isUndefined(parsed.ssh_authorized_keys);
        assert.isUndefined(parsed.lock_password);
    });
});

describe("CloudInit", () => {

    it("should initialize with all fields", () => {
        const ci = cloudInit(Packages("nginx", { name: "curl", version: "7.79.1" }),
            NewUser({ name: "bob", password: "pw" }),
            PackageUpdate,
            WriteFile("/tmp/test.txt", "hello", "0644", "root:root"),
            (args) => {
                args.runcmd = ["echo hello", ["ls", "-l"]];
                return args;
            });

        assert.equal(ci.templated, false);
        assert.equal(ci.users?.length, 1);
        assert.equal((ci.users?.[0] as CloudInitUser).name, "bob");
        assert.deepEqual(ci.packages, [
            "nginx",
            { name: "curl", version: "7.79.1" }
        ]);
        assert.equal(ci.packageUpdate, true);
        assert.equal(ci.packageUpgrade, false);
        assert.deepEqual(ci.writeFiles, [
            { path: "/tmp/test.txt", content: "hello", permissions: "0644", owner: "root:root" }
        ]);
        assert.deepEqual(ci.runcmd, [
            "echo hello",
            ["ls", "-l"]
        ]);
    });

    it("should generate correct YAML with all fields", () => {
        const ci = cloudInit(
            Packages("vim", ["git", "2.30.0"]),
            NewUser({ name: "alice", password: "pw", shell: "/bin/zsh" }),
            PackageUpdate,
            PackageUpgrade,
            WriteFile("/etc/motd", "Welcome", "0644"),
            (args) => {
                args.runcmd = ["uptime", ["systemctl", "enable", "--now"]];
                return args;
            }
        );

        const args = {
            templated: true,
            users: [
                { name: "alice", password: "pw", shell: "/bin/zsh" }
            ],
            packages: [
                "vim",
                ["git", "2.30.0"]
            ],
            packageUpdate: true,
            packageUpgrade: true,
            writeFiles: [
                { path: "/etc/motd", content: "Welcome", permissions: "0644" }
            ],
            runcmd: [
                "uptime",
                ["systemctl", "enable", "--now"]
            ]
        };
        const yamlStr = renderCloudInit(ci);
        const parsed = yaml.parse(yamlStr);

        assert.ok(Array.isArray(parsed.users));
        assert.equal(parsed.users[0].name, "alice");
        assert.equal(parsed.users[0].shell, "/bin/zsh");
        assert.deepEqual(parsed.packages, [
            "vim",
            ["git", "2.30.0"]
        ]);
        assert.equal(parsed.package_update, true);
        assert.equal(parsed.package_upgrade, true);
        assert.deepEqual(parsed.write_files, [
            { path: "/etc/motd", content: "Welcome", permissions: "0644" }
        ]);
        assert.deepEqual(parsed.runcmd, [
            "uptime",
            ["systemctl", "enable", "--now"]
        ]);
    });

    it("should add cloud config preamble", () => {
        const ci = cloudInit((args) => { args.templated = true; return args; });
        const yamlStr = renderCloudInit(ci);
        assert.ok(yamlStr.startsWith("## template: jinja\n#cloud-config"));
    });

    it("should add cloud config preamble without templated", () => {
        const ci = cloudInit((args) => { args.templated = false; return args; });
        const yamlStr = renderCloudInit(ci);
        assert.ok(yamlStr.startsWith("#cloud-config"));
    });

    it("should omit undefined fields in YAML", () => {
        const ci = cloudInit((args) => { args.templated = true; return args; });
        const yamlStr = renderCloudInit(ci);
        const parsed = yaml.parse(yamlStr);
        console.log(parsed);
        assert.ok(!("users" in parsed));
        assert.ok(!("packages" in parsed));
        assert.ok(!("package_update" in parsed));
        assert.ok(!("package_upgrade" in parsed));
        assert.ok(!("write_files" in parsed));
        assert.ok(!("runcmd" in parsed));
    });
});
