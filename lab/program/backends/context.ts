import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { HarvesterBase } from "@lab/harvester";
import type { CloudInitVars, ResolvedLab } from "@lab/schema";

/** What the program gives a host backend: the lab, what its sites already made, and the host's own cloud-init steps. */
export interface BackendContext {
    lab: ResolvedLab;
    /** Each Harvester's base (namespace, images, networks), by Harvester name. */
    bases: Record<string, HarvesterBase>;
    /** Each Harvester's Kubernetes provider, by name. */
    providers: Record<string, k8s.Provider>;
    /** What an OS profile's cloud-init templates use: the lab's secrets (kept secret), its name and domain. */
    osVars(): pulumi.Output<CloudInitVars>;
    /** What the host's profiles add to its cloud-init `runcmd`. */
    runcmd: string[];
}
