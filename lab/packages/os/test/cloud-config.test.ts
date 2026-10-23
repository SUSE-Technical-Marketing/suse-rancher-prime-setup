import type { ResolvedOs } from "@lab/schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCloudConfig } from "../src";

const base: ResolvedOs = {
    name: "test", displayName: "Test", family: "suse", imageUrl: null,
    repos: [], packages: [], k8s: { packages: [] }, cloudInit: {},
};
const user = { name: "lab", publicKey: "ssh-ed25519 AAAA lab" };

function render(os: Partial<ResolvedOs>, extra: Partial<Parameters<typeof renderCloudConfig>[0]> = {}) {
    const text = renderCloudConfig({ os: { ...base, ...os }, hostname: "vm", fqdn: "vm.lab.example.com", user, ...extra });
    expect(text.startsWith("#cloud-config\n")).toBe(true);
    return parse(text);
}

describe("renderCloudConfig", () => {
    it("creates only the lab user, with the SSH key and no password login", () => {
        const cfg = render({});
        expect(cfg.users).toEqual([{ name: "lab", sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true, ssh_authorized_keys: [user.publicKey] }]);
        expect(cfg.ssh_pwauth).toBe(false);
        expect(cfg).toMatchObject({ hostname: "vm", fqdn: "vm.lab.example.com" });
    });

    it("makes the lab user the default user, without a hostname, for Rancher-provisioned machines", () => {
        const cfg = render({}, { hostname: undefined, fqdn: undefined, defaultUser: true });
        expect(cfg.users).toEqual(["default"]);
        expect(cfg.system_info.default_user).toEqual({ name: "lab", sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true });
        expect(cfg.ssh_authorized_keys).toEqual([user.publicKey]);
        expect(cfg.hostname).toBeUndefined();
        expect(cfg.manage_etc_hosts).toBeUndefined();
    });

    it("registers, then adds repos, then installs packages (suse)", () => {
        const cfg = render({
            registration: { suseconnect: { regcode: { $secret: "x" } } },
            repos: [{ name: "oss", url: "http://example.com/oss/", gpgkey: "http://example.com/key" }],
            packages: ["vim", "qemu-guest-agent"],
            k8s: { packages: ["k3s-selinux"] },
        }, { regcode: "REG-123", kubernetes: true });
        expect(cfg.runcmd).toEqual([
            "suseconnect --regcode 'REG-123'",
            "rpm --import 'http://example.com/key'",
            "zypper --non-interactive addrepo --refresh 'http://example.com/oss/' 'oss'",
            "zypper --non-interactive --gpg-auto-import-keys refresh",
            "zypper --non-interactive install --no-recommends 'vim' 'qemu-guest-agent' 'k3s-selinux'",
            "systemctl enable --now qemu-guest-agent",
        ]);
    });

    it("fails without a registration code when the OS needs one", () => {
        expect(() => render({ registration: { suseconnect: { regcode: { $secret: "x" } } } })).toThrow(/registration code/);
    });

    it("uses dnf for rhel and apt for debian", () => {
        expect(render({ family: "rhel", packages: ["vim-enhanced"] }).runcmd).toEqual(["dnf -y install 'vim-enhanced'"]);
        expect(render({ family: "debian", packages: ["vim"] }).runcmd).toEqual([
            "apt-get update",
            "DEBIAN_FRONTEND=noninteractive apt-get install -y 'vim'",
        ]);
    });

    it("lets the profile's raw cloudInit override keys", () => {
        expect(render({ cloudInit: { timezone: "Europe/Amsterdam", ssh_pwauth: true } })).toMatchObject({ timezone: "Europe/Amsterdam", ssh_pwauth: true });
    });

    it("quotes values for the shell", () => {
        expect(render({ packages: ["it's"] }).runcmd[1]).toBe(`zypper --non-interactive install --no-recommends 'it'\\''s'`);
    });
});
