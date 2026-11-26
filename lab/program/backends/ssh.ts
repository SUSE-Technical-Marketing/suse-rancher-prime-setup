import * as pulumi from "@pulumi/pulumi";
import type { HostBackend } from "@lab/backends";
import type { BackendContext } from "./context";

/** An existing machine: nothing to create, it is reached at its own address. Its setup runs over SSH (see index.ts). */
export const sshBackend: HostBackend<"ssh", BackendContext> = {
    kind: "ssh",
    provision: host => ({ address: pulumi.output(host.address), ready: [] }),
};
