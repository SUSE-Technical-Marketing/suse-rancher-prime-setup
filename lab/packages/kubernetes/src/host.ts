import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

/** How to reach a host over SSH: a Harvester VM once it has an address, or an existing machine. */
export interface HostAccess {
    name: string;
    fqdn: string;
    address: pulumi.Input<string>;
    user: string;
    privateKey: pulumi.Input<string>;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Run a shell script as root over SSH, whether the login is root or a passwordless sudoer. */
/**
 * Commands as a script for an existing machine, as cloud-init runs a VM's `runcmd`: each as written,
 * one after the other, stopping at the first that fails. Each is its own group, so a multi-line one
 * works (an OS profile's `if … fi` block) and so does `cmd || true`; only a command's own result
 * counts, a failure inside it (`systemctl stop x; …`) is its business. Each step says which it is,
 * and a failure which one failed.
 */
export function stepScript(commands: string[]): string {
    const n = commands.length;
    return ["#!/bin/sh", ...commands.flatMap((c, i) => [
        `echo "lab: step ${i + 1}/${n}" >&2`,
        `{\n${c.trimEnd()}\n} || { rc=$?; echo "lab: step ${i + 1}/${n} failed (exit $rc)" >&2; exit $rc; }`,
    ]), ""].join("\n");
}

/**
 * The remote command that runs a script given on its stdin, as root: stored root-only under
 * /var/lib/lab as `<name>.sh`, run with sh, and removed once it succeeds (it can hold a
 * registration token); a failed one stays there, to look at.
 */
export function runUploaded(name: string): string {
    const file = `/var/lib/lab/${name.replace(/[^A-Za-z0-9._-]/g, "-")}.sh`;
    return asRoot(`umask 077 && mkdir -p /var/lib/lab && cat > ${file} && sh ${file} && rm -f ${file}`);
}

export const asRoot = (script: string) => `if [ "$(id -u)" -eq 0 ]; then sh -c ${quote(script)}; else sudo -n sh -c ${quote(script)}; fi`;

/** Run the scripts that exist of `scripts` (uninstall scripts, as root); missing ones are skipped. */
export const runExisting = (scripts: string[]) => [...scripts.map(s => `if [ -x ${quote(s)} ]; then ${quote(s)}; fi`), "true"].join("; ");

export function sshConnection(host: HostAccess): command.types.input.remote.ConnectionArgs {
    return {
        host: host.address,
        user: host.user,
        privateKey: host.privateKey,
        dialErrorLimit: 30,
        perDialTimeout: 20,
    };
}

/**
 * Wait until cloud-init has finished on the host. On failure the command prints the tail of
 * cloud-init's output log, so the Pulumi error shows what went wrong on the VM.
 */
export function waitForCloudInit(name: string, host: HostAccess, timeoutSeconds: number, opts?: pulumi.CustomResourceOptions): command.remote.Command {
    return new command.remote.Command(name, {
        connection: sshConnection(host),
        create: [
            `sudo timeout ${timeoutSeconds} cloud-init status --wait >/dev/null`,
            `|| { [ $? = 124 ] && echo 'cloud-init not done after ${timeoutSeconds}s' >&2 || echo 'cloud-init failed' >&2;`,
            "echo 'last lines of /var/log/cloud-init-output.log:' >&2;",
            "sudo tail -n 40 /var/log/cloud-init-output.log >&2; exit 1; }",
        ].join(" "),
    }, opts);
}
