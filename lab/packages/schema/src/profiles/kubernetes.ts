import { z } from "zod";
import { defineProfile } from "./define";

export const k3s = defineProfile({
    name: "k3s",
    description: "Single-node k3s cluster on the host",
    settings: z.strictObject({ version: z.string().optional() }),
    provides: ["kubernetes"],
    conflicts: ["kubernetes"],
});

export const rke2 = defineProfile({
    name: "rke2",
    description: "Single-node RKE2 cluster on the host",
    settings: z.strictObject({ version: z.string().optional() }),
    provides: ["kubernetes"],
    conflicts: ["kubernetes"],
});
