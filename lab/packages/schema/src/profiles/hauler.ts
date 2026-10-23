import { z } from "zod";
import { defineProfile } from "./define";

export const hauler = defineProfile({
    name: "hauler",
    description: "Hauler registry for air-gapped installs; on Kubernetes if the host has it, else as a systemd service",
    settings: z.strictObject({
        manifests: z.array(z.string()).default([]),
        port: z.int().min(1).max(65535).optional(),
    }),
    provides: ["registry"],
});
