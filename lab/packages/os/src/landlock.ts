import type { ResolvedOs } from "@lab/schema";

// Landlock (the landlock profile): the kernel's sandboxing LSM, which OpenShell's agent sandboxes
// need on every node they run on. The kernels of the lab's OSes have it built in; where it isn't in
// the active LSM list, it's turned on with `lsm=` on the kernel command line (the OS profile's
// `landlock.enable` knows its bootloader), which takes a reboot.

/** Succeeds when Landlock is active; otherwise says which LSMs are, and fails. */
export const LANDLOCK_CHECK = [
    "lsm=$(cat /sys/kernel/security/lsm)",
    `case ",$lsm," in *,landlock,*) ;; *) echo "landlock isn't active on $(hostname): its LSMs are $lsm" >&2; exit 1 ;; esac`,
].join("\n");

/**
 * A node's first boot, from cloud-init's `bootcmd`: that runs before sshd starts and before
 * cloud-init installs packages or runs `runcmd` (Kubernetes), which then run after the reboot.
 * cloud-init is stopped by the shutdown, so it doesn't go on in the meantime.
 */
export const CLOUD_INIT_REBOOT = "systemctl reboot\nsleep 600";

/** An existing machine, over SSH: shortly after the command has returned, so the session ends cleanly. */
export const MACHINE_REBOOT = 'echo "lab: rebooting"\nsystemd-run --on-active=5 systemctl reboot >/dev/null 2>&1';

/**
 * Turn Landlock on, then `reboot`; nothing when it's active already. The current LSMs stay (SELinux
 * or AppArmor), landlock goes first. If the kernel command line already asks for landlock and it
 * still isn't active, the kernel can't: it fails instead of rebooting again. A subshell, so its
 * `exit` ends only this part of a script (cloud-init runs all of `bootcmd` as one).
 */
export function landlockScript(os: ResolvedOs, reboot: string): string {
    if (!os.landlock) throw new Error(`OS profile ${os.name} has no landlock.enable`);
    return [
        "(",
        "lsm=$(cat /sys/kernel/security/lsm)",
        `case ",$lsm," in *,landlock,*) echo "lab: landlock is active ($lsm)" >&2; exit 0 ;; esac`,
        "if grep -qE '(^| )lsm=([^ ]*,)?landlock(,| |$)' /proc/cmdline; then",
        `  echo "lab: lsm= on the kernel command line has landlock, but it isn't active ($lsm): does this kernel have CONFIG_SECURITY_LANDLOCK?" >&2`,
        "  exit 1",
        "fi",
        'lsm="landlock,$lsm"',
        `echo "lab: turning landlock on (lsm=$lsm), then rebooting" >&2`,
        // Its status tested on its own: `set -e` doesn't hold in a subshell that is part of `||`.
        `( set -e\n${os.landlock.enable.trimEnd()}\n)`,
        `[ $? -eq 0 ] || { echo "lab: turning landlock on failed" >&2; exit 1; }`,
        reboot,
        ")",
    ].join("\n");
}
