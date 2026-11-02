import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCatalog, type ResolvedOs } from "@lab/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CLOUD_INIT_REBOOT, LANDLOCK_CHECK, landlockScript, renderCloudConfig } from "../src";

const base: ResolvedOs = {
    name: "test", displayName: "Test", family: "suse", imageUrl: null, image: "test", cloudInit: {}, harvester: {}, kubernetes: {},
    landlock: { enable: 'echo "enable lsm=$lsm" >> "$LOG"' },
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "landlock-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Run a script as a node would, its files in `dir`: `lsm` (the active LSMs), `cmdline`, and any
 * other path in `files` (`/etc/default/grub`). Commands in `stubs` log their arguments instead.
 */
function run(script: string, opts: { lsm: string; cmdline?: string; files?: Record<string, string>; stubs?: string[] }) {
    const at = (p: string) => path.join(dir, p.replace(/\//g, "_"));
    let s = script.replace(/\/sys\/kernel\/security\/lsm/g, at("lsm")).replace(/\/proc\/cmdline/g, at("cmdline"));
    fs.writeFileSync(at("lsm"), opts.lsm);
    fs.writeFileSync(at("cmdline"), opts.cmdline ?? "BOOT_IMAGE=/boot/vmlinuz root=UUID=x rw quiet");
    for (const [p, content] of Object.entries(opts.files ?? {})) {
        fs.writeFileSync(at(p), content);
        s = s.split(p).join(at(p));
    }
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const stub of opts.stubs ?? []) fs.writeFileSync(path.join(bin, stub), `#!/bin/sh\necho "${stub} $*" >> "$LOG"\n`, { mode: 0o755 });
    const log = path.join(dir, "log");
    let status = 0, stderr = "";
    try {
        execFileSync("sh", ["-c", s], { env: { ...process.env, LOG: log, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        const err = e as { status: number; stderr: Buffer };
        status = err.status;
        stderr = err.stderr.toString();
    }
    return { status, stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", read: (p: string) => fs.readFileSync(at(p), "utf8") };
}

const REBOOT = 'echo reboot >> "$LOG"';

describe("turning Landlock on", () => {
    it("does nothing when it's active", () => {
        const r = run(landlockScript(base, REBOOT), { lsm: "lockdown,capability,landlock,yama,selinux,bpf" });
        expect(r).toMatchObject({ status: 0, log: "" });
    });

    it("puts landlock first, keeping the active LSMs, then reboots", () => {
        const r = run(landlockScript(base, REBOOT), { lsm: "lockdown,capability,yama,selinux,bpf" });
        expect(r).toMatchObject({ status: 0, log: "enable lsm=landlock,lockdown,capability,yama,selinux,bpf\nreboot\n" });
    });

    it("doesn't reboot again when the kernel was asked for landlock and still hasn't it", () => {
        const r = run(landlockScript(base, REBOOT), { lsm: "lockdown,capability,yama,selinux", cmdline: "root=UUID=x lsm=landlock,lockdown,capability,yama,selinux quiet" });
        expect(r.status).toBe(1);
        expect(r.log).toBe("");
        expect(r.stderr).toContain("CONFIG_SECURITY_LANDLOCK");
    });

    it("doesn't reboot when the OS's commands fail, and stops at the first that does", () => {
        const r = run(landlockScript({ ...base, landlock: { enable: 'false\necho "not reached" >> "$LOG"' } }, REBOOT), { lsm: "selinux" });
        expect(r).toMatchObject({ status: 1, log: "" });
        expect(r.stderr).toContain("turning landlock on failed");
    });

    it("ends only its own part of a longer script", () => {
        const r = run(`${landlockScript(base, REBOOT)}\necho after >> "$LOG"`, { lsm: "landlock,selinux" });
        expect(r.log).toBe("after\n");
    });

    it("needs the OS profile to say how", () => {
        expect(() => landlockScript({ ...base, landlock: undefined }, REBOOT)).toThrow("OS profile test has no landlock.enable");
    });
});

describe("the SUSE OS profiles' landlock.enable", () => {
    const { catalog } = loadCatalog({ personalConfig: path.join(os.tmpdir(), "no-such-config.yaml") });
    const leap = { ...base, landlock: catalog!.os["leap-16"].value.landlock };
    const grub = 'GRUB_TIMEOUT=8\nGRUB_CMDLINE_LINUX_DEFAULT="rw quiet console=ttyS0,115200 security=selinux selinux=1"\nGRUB_CMDLINE_LINUX=""\n';

    it("adds lsm= to GRUB's default command line and refreshes it", () => {
        const r = run(landlockScript(leap, REBOOT), {
            lsm: "lockdown,capability,yama,selinux,bpf",
            files: { "/etc/sysconfig/bootloader": "LOADER_TYPE=grub2-efi\n", "/etc/default/grub": grub },
            stubs: ["update-bootloader"],
        });
        expect(r.status).toBe(0);
        expect(r.read("/etc/default/grub")).toBe(grub.replace('DEFAULT="rw', 'DEFAULT="lsm=landlock,lockdown,capability,yama,selinux,bpf rw'));
        expect(r.log).toBe("update-bootloader --refresh\nreboot\n");
    });

    it("replaces an lsm= that's there already", () => {
        const r = run(landlockScript(leap, REBOOT), {
            lsm: "lockdown,selinux",
            files: { "/etc/sysconfig/bootloader": "LOADER_TYPE=grub2\n", "/etc/default/grub": 'GRUB_CMDLINE_LINUX_DEFAULT="quiet lsm=lockdown,selinux splash"\n' },
            stubs: ["update-bootloader"],
        });
        expect(r.read("/etc/default/grub")).toBe('GRUB_CMDLINE_LINUX_DEFAULT="lsm=landlock,lockdown,selinux quiet splash"\n');
    });

    it("replaces one at the start without leaving a gap", () => {
        const r = run(landlockScript(leap, REBOOT), {
            lsm: "lockdown,selinux",
            files: { "/etc/sysconfig/bootloader": "LOADER_TYPE=grub2-efi\n", "/etc/default/grub": 'GRUB_CMDLINE_LINUX_DEFAULT="lsm=lockdown,selinux rw quiet"\n' },
            stubs: ["update-bootloader"],
        });
        expect(r.read("/etc/default/grub")).toBe('GRUB_CMDLINE_LINUX_DEFAULT="lsm=landlock,lockdown,selinux rw quiet"\n');
    });

    it("appends it to /etc/kernel/cmdline with systemd-boot", () => {
        const r = run(landlockScript(leap, REBOOT), {
            lsm: "lockdown,selinux",
            files: { "/etc/sysconfig/bootloader": "LOADER_TYPE=systemd-boot\n", "/etc/kernel/cmdline": "root=UUID=x rw quiet\n" },
            stubs: ["sdbootutil"],
        });
        expect(r.read("/etc/kernel/cmdline")).toBe("root=UUID=x rw quiet lsm=landlock,lockdown,selinux\n");
        expect(r.log).toBe("sdbootutil update-all-entries\nreboot\n");
    });

    it("fails on a bootloader it doesn't know, without rebooting", () => {
        const r = run(landlockScript(leap, REBOOT), { lsm: "selinux", files: { "/etc/sysconfig/bootloader": "LOADER_TYPE=lilo\n" } });
        expect(r).toMatchObject({ status: 1, log: "" });
        expect(r.stderr).toContain('LOADER_TYPE "lilo"');
    });
});

describe("the check", () => {
    it("passes with landlock active, and otherwise names the active LSMs", () => {
        expect(run(LANDLOCK_CHECK, { lsm: "lockdown,landlock,selinux" }).status).toBe(0);
        const r = run(LANDLOCK_CHECK, { lsm: "lockdown,selinux" });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/landlock isn't active on .*: its LSMs are lockdown,selinux/);
    });
});

describe("a node's user data", () => {
    const user = { name: "lab", publicKey: "ssh-ed25519 AAAA lab" };
    const vars = { secrets: {}, lab: { name: "lab1", domain: "lab.example.com", vars: {} } };
    const render = (landlock: boolean) => parse(renderCloudConfig({
        os: { ...base, cloudInit: { bootcmd: ["cloud-init-per once register suseconnect"] } }, harvester: true, kubernetes: true, user, vars,
        bootcmd: landlock ? [landlockScript(base, CLOUD_INIT_REBOOT)] : [],
    }));

    it("runs the host's bootcmd (Landlock's) after the OS profile's, with cloud-init's reboot", () => {
        const { bootcmd } = render(true);
        expect(bootcmd).toEqual(["cloud-init-per once register suseconnect", landlockScript(base, CLOUD_INIT_REBOOT)]);
        expect(bootcmd[1]).toContain("systemctl reboot");
    });

    it("leaves bootcmd alone without any of its own", () => {
        expect(render(false).bootcmd).toEqual(["cloud-init-per once register suseconnect"]);
    });
});
