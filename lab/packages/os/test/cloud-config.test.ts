import type { ResolvedOs } from "@lab/schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { machineSetup, renderCloudConfig } from "../src";

const base: ResolvedOs = {
    name: "test", displayName: "Test", family: "suse", imageUrl: null, image: "test", cloudInit: {},
};
const user = { name: "lab", publicKey: "ssh-ed25519 AAAA lab" };
const vars = { secrets: { "scc-regcode": "REG-123" }, lab: { name: "lab1", domain: "lab.example.com", vars: {} } };

function render(os: Partial<ResolvedOs>, extra: Partial<Parameters<typeof renderCloudConfig>[0]> = {}) {
    const text = renderCloudConfig({ os: { ...base, ...os }, hostname: "vm", fqdn: "vm.lab.example.com", user, vars, ...extra });
    expect(text.startsWith("#cloud-config\n")).toBe(true);
    return parse(text);
}

describe("renderCloudConfig", () => {
    it("creates only the lab user, with the SSH key and no password login", () => {
        const cfg = render({});
        expect(cfg.users).toEqual([{ name: "lab", sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true, ssh_authorized_keys: [user.publicKey] }]);
        expect(cfg.ssh_pwauth).toBe(false);
        expect(cfg).toMatchObject({ hostname: "vm", fqdn: "vm.lab.example.com" });
        expect(cfg.runcmd).toBeUndefined();
    });

    it("makes the lab user the default user, without a hostname, for Rancher-provisioned machines", () => {
        const cfg = render({}, { hostname: undefined, fqdn: undefined, defaultUser: true });
        expect(cfg.users).toEqual(["default"]);
        expect(cfg.system_info.default_user).toEqual({ name: "lab", sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true });
        expect(cfg.ssh_authorized_keys).toEqual([user.publicKey]);
        expect(cfg.hostname).toBeUndefined();
        expect(cfg.manage_etc_hosts).toBeUndefined();
    });

    it("is the OS profile's cloud-config, with the host's commands after the profile's", () => {
        const cfg = render({
            cloudInit: { package_update: true, packages: ["vim", "open-iscsi"], runcmd: ["systemctl enable --now iscsid"], timezone: "Europe/Amsterdam", ssh_pwauth: true },
        }, { runcmd: ["curl -sfL https://get.k3s.io | sh -"] });
        expect(cfg).toMatchObject({ package_update: true, packages: ["vim", "open-iscsi"], timezone: "Europe/Amsterdam", ssh_pwauth: true });
        expect(cfg.runcmd).toEqual(["systemctl enable --now iscsid", "curl -sfL https://get.k3s.io | sh -"]);
    });

    it("renders the profile's templates with its secrets and the lab", () => {
        const cfg = render({ cloudInit: { bootcmd: ["cloud-init-per once register suseconnect --regcode '{{ secrets[\"scc-regcode\"] }}'"], fqdn_suffix: "{{ lab.domain }}" } });
        expect(cfg.bootcmd).toEqual(["cloud-init-per once register suseconnect --regcode 'REG-123'"]);
        expect(cfg.fqdn_suffix).toBe("lab.example.com");
        expect(() => render({ cloudInit: { runcmd: ["{{ secrets.nope }}"] } })).toThrow(/OS profile test: cloudInit.runcmd\[0\]: template/);
    });
});

describe("machineSetup", () => {
    it("installs the profile's packages with the family's package manager, then runs its runcmd", () => {
        const os = { ...base, cloudInit: { packages: ["vim", "it's"], runcmd: ["systemctl enable --now iscsid", ["echo", "a b"]], write_files: [] } };
        expect(machineSetup(os, vars)).toEqual([
            "zypper --non-interactive --gpg-auto-import-keys refresh",
            `zypper --non-interactive install --no-recommends 'vim' 'it'\\''s'`,
            "systemctl enable --now iscsid",
            "'echo' 'a b'",
        ]);
        expect(machineSetup({ ...os, family: "rhel" }, vars)[0]).toBe(`dnf -y install 'vim' 'it'\\''s'`);
        expect(machineSetup({ ...os, family: "debian" }, vars).slice(0, 2)).toEqual(["apt-get update", `DEBIAN_FRONTEND=noninteractive apt-get install -y 'vim' 'it'\\''s'`]);
        expect(machineSetup(base, vars)).toEqual([]);
        expect(machineSetup({ ...base, cloudInit: { runcmd: ["echo {{ secrets['scc-regcode'] }}"] } }, vars)).toEqual(["echo REG-123"]);
    });
});
