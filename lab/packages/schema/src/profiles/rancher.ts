import { z } from "zod";
import { Credentials, dnsLabel, secretOrString } from "../primitives";
import { defineProfile } from "./define";

const FleetRepo = z.strictObject({
    name: dnsLabel,
    url: z.url(),
    branch: z.string().optional(),
    paths: z.array(z.string()).optional(),
    group: z.string().optional(),
    namespace: z.string().optional(),
    helmSecretName: z.string().optional(),
    helmRepoURLRegex: z.string().optional(),
});

export const rancher = defineProfile({
    name: "rancher",
    description: "Rancher Manager on the host's Kubernetes cluster, with UI plugins and Fleet",
    settings: z.strictObject({
        version: z.string().optional(),
        /** First label of Rancher's name: `<hostname>.<host>.<domain>`, covered by the wildcard certificate. */
        hostname: dnsLabel.default("rancher"),
        adminPassword: secretOrString,
        plugins: z.array(z.string()).optional(),
        liz: z.boolean().optional(),
        fleet: z.strictObject({
            /** Secrets the apps in `apps/` need, propagated to downstream clusters by Outrider. */
            secrets: z.strictObject({
                appco: Credentials.optional(),
                scc: Credentials.optional(),
                "suse-observability-license": secretOrString.optional(),
            }).optional(),
            groups: z.record(dnsLabel, z.record(z.string(), z.string())).default({}),
            repos: z.union([z.enum(["default", "none"]), z.array(FleetRepo)]).default("default"),
        }).optional(),
    }),
    requires: ["kubernetes", "ingress", "tls", "secret-propagation"],
    requiresWhen: [{ field: "fleet.secrets", capability: "downstream-secrets" }],
    secretFields: [
        "adminPassword",
        { field: "fleet.secrets.appco", shape: "credentials" },
        { field: "fleet.secrets.scc", shape: "credentials" },
        "fleet.secrets.suse-observability-license",
    ],
});
