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
export function waitForCloudInit(name: string, host: HostAccess, opts?: pulumi.CustomResourceOptions): command.remote.Command {
    return new command.remote.Command(name, {
        connection: sshConnection(host),
        create: [
            "sudo cloud-init status --wait >/dev/null",
            "|| { echo 'cloud-init failed; last lines of /var/log/cloud-init-output.log:' >&2;",
            "sudo tail -n 40 /var/log/cloud-init-output.log >&2; exit 1; }",
        ].join(" "),
    }, opts);
}
