import type { HostBackends } from "@lab/backends";
import type { BackendContext } from "./context";
import { harvesterBackend } from "./harvester";
import { sshBackend } from "./ssh";

export type { BackendContext } from "./context";

/** The program's host backends, one per host kind: the compiler checks none is missing. */
export const hostBackends: HostBackends<BackendContext> = {
    harvester: harvesterBackend,
    ssh: sshBackend,
};
