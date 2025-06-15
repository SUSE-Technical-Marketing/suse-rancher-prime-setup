import * as yaml from "yaml";
import {
    cloudInit,
    CloudInitUser,
    CloudInitUserArgs,
    renderCloudInit,
    renderUser,
    createDhcpInterface,
    createStaticInterface,
    createNetworkConfig
} from "../src/cloud-init";
import { assert } from "chai";
import { describe, it } from "mocha";
import {
    NewUser,
    Packages,
    PackageUpdate,
    PackageUpgrade,
    WriteFile,
    NetworkConfiguration,
    DhcpInterface,
    StaticInterface
} from "../src/processors";

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
        assert.ok(!("network" in parsed));
    });
});

describe("Network Configuration", () => {

    it("should create DHCP interface", () => {
        const iface = createDhcpInterface("enp1s0", "00:11:22:33:44:55");
        assert.equal(iface.type, "physical");
        assert.equal(iface.name, "enp1s0");
        assert.equal(iface.mac_address, "00:11:22:33:44:55");
        assert.equal(iface.subnets?.length, 1);
        assert.equal(iface.subnets?.[0].type, "dhcp");
    });

    it("should create static interface", () => {
        const iface = createStaticInterface(
            "enp2s0",
            "192.168.1.100",
            "255.255.255.0",
            "192.168.1.1",
            ["8.8.8.8", "8.8.4.4"],
            "00:11:22:33:44:66"
        );
        assert.equal(iface.type, "physical");
        assert.equal(iface.name, "enp2s0");
        assert.equal(iface.mac_address, "00:11:22:33:44:66");
        assert.equal(iface.subnets?.length, 1);
        assert.equal(iface.subnets?.[0].type, "static");
        assert.equal(iface.subnets?.[0].address, "192.168.1.100");
        assert.equal(iface.subnets?.[0].netmask, "255.255.255.0");
        assert.equal(iface.subnets?.[0].gateway, "192.168.1.1");
        assert.deepEqual(iface.subnets?.[0].dns_nameservers, ["8.8.8.8", "8.8.4.4"]);
    });

    it("should create network config", () => {
        const dhcpIface = createDhcpInterface("enp1s0");
        const staticIface = createStaticInterface("enp2s0", "192.168.1.100", "255.255.255.0");
        const networkConfig = createNetworkConfig([dhcpIface, staticIface]);

        assert.equal(networkConfig.version, 1);
        assert.equal(networkConfig.config?.length, 2);
        assert.equal(networkConfig.config?.[0].name, "enp1s0");
        assert.equal(networkConfig.config?.[1].name, "enp2s0");
    });

    it("should add network config to cloud-init", () => {
        const networkConfig = createNetworkConfig([
            createDhcpInterface("enp1s0"),
            createDhcpInterface("enp2s0")
        ]);

        const ci = cloudInit(NetworkConfiguration(networkConfig));
        assert.equal(ci.network?.version, 1);
        assert.equal(ci.network?.config?.length, 2);
        assert.equal(ci.network?.config?.[0].name, "enp1s0");
        assert.equal(ci.network?.config?.[1].name, "enp2s0");
    });

    it("should render network config in YAML", () => {
        const ci = cloudInit(
            DhcpInterface("enp1s0"),
            DhcpInterface("enp2s0")
        );

        const yamlStr = renderCloudInit(ci);
        const parsed = yaml.parse(yamlStr);

        assert.ok("network" in parsed);
        assert.equal(parsed.network.version, 1);
        assert.equal(parsed.network.config.length, 2);
        assert.equal(parsed.network.config[0].name, "enp1s0");
        assert.equal(parsed.network.config[0].type, "physical");
        assert.equal(parsed.network.config[0].subnets[0].type, "dhcp");
        assert.equal(parsed.network.config[1].name, "enp2s0");
        assert.equal(parsed.network.config[1].type, "physical");
        assert.equal(parsed.network.config[1].subnets[0].type, "dhcp");
    });

    it("should render static interface in YAML", () => {
        const ci = cloudInit(
            StaticInterface("enp1s0", "192.168.1.100", "255.255.255.0", "192.168.1.1", ["8.8.8.8"])
        );

        const yamlStr = renderCloudInit(ci);
        const parsed = yaml.parse(yamlStr);

        assert.ok("network" in parsed);
        assert.equal(parsed.network.config[0].subnets[0].type, "static");
        assert.equal(parsed.network.config[0].subnets[0].address, "192.168.1.100");
        assert.equal(parsed.network.config[0].subnets[0].netmask, "255.255.255.0");
        assert.equal(parsed.network.config[0].subnets[0].gateway, "192.168.1.1");
        assert.deepEqual(parsed.network.config[0].subnets[0].dns_nameservers, ["8.8.8.8"]);
    });

    it("should match the example network config format", () => {
        const ci = cloudInit(
            DhcpInterface("enp1s0"),
            DhcpInterface("enp2s0")
        );

        const yamlStr = renderCloudInit(ci);
        const parsed = yaml.parse(yamlStr);

        // This should match the format from the user's example
        const expectedStructure = {
            version: 1,
            config: [
                {
                    type: "physical",
                    name: "enp1s0",
                    subnets: [{ type: "dhcp" }]
                },
                {
                    type: "physical",
                    name: "enp2s0",
                    subnets: [{ type: "dhcp" }]
                }
            ]
        };

        assert.deepEqual(parsed.network, expectedStructure);
    });
});
