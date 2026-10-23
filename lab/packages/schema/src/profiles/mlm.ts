import { z } from "zod";
import { secretOrString } from "../primitives";
import { defineProfile } from "./define";

export const mlmServer = defineProfile({
    name: "mlm-server",
    description: "SUSE Multi-Linux Manager server (containers on SL Micro, installed with mgradm)",
    settings: z.strictObject({
        version: z.string().optional(),
        adminPassword: secretOrString,
        products: z.union([z.literal("auto"), z.array(z.string())]).default("auto"),
    }),
    // mgradm runs the server with podman on SL Micro; no Kubernetes or MLM client next to it.
    osFamilies: ["suse"],
    conflicts: ["kubernetes", "mlm-client"],
    secretFields: ["adminPassword"],
});

export const mlmClient = defineProfile({
    name: "mlm-client",
    description: "Registers the host with a Multi-Linux Manager server in the lab",
    settings: z.strictObject({
        server: z.string(),
        activationKey: z.string().optional(),
    }),
    hostRefs: [{ field: "server", provides: "mlm-server" }],
});
