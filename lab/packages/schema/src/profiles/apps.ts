import { z } from "zod";
import { defineProfile } from "./define";

// Cluster apps: each is its own profile so they compose (DESIGN.md §5.4). All of them run on the
// host's own Kubernetes cluster.

export const certManager = defineProfile({
    name: "cert-manager",
    description: "cert-manager with Let's Encrypt issuers (Cloudflare DNS-01) and a wildcard certificate for the host",
    settings: z.strictObject({ version: z.string().optional() }),
    requires: ["kubernetes"],
    provides: ["tls"],
});

export const sprouter = defineProfile({
    name: "sprouter",
    description: "Sprouter: copies labelled secrets (the wildcard certificate) into every namespace",
    settings: z.strictObject({ version: z.string().optional() }),
    requires: ["kubernetes"],
    provides: ["secret-propagation"],
});

export const traefik = defineProfile({
    name: "traefik",
    description: "Traefik ingress controller with the Gateway API CRDs and its Gateway provider",
    settings: z.strictObject({
        version: z.string().optional(),
        gatewayApi: z.strictObject({
            version: z.string().optional(),
            channel: z.enum(["standard", "experimental"]).default("standard"),
        }).optional(),
    }),
    requires: ["kubernetes"],
    uses: ["load-balancer"],
    provides: ["ingress"],
});

export const outrider = defineProfile({
    name: "outrider",
    description: "Outrider: propagates annotated secrets to downstream clusters",
    settings: z.strictObject({ version: z.string().optional() }),
    requires: ["kubernetes"],
    provides: ["downstream-secrets"],
});
