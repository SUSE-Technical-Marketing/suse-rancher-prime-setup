import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { stringify } from "yaml";
import { HarvesterAddon } from "@lab/harvester";
import { chart } from "../catalog";
import type { ProfileBuilder } from "../profiles";
import { credentials } from "../secrets";

// The harvester-dns-controller profile (DESIGN.md §8): DNS records for the lab's VMs on the router,
// by a Harvester add-on, so it's listed (and its values shown) under the Harvester's Add-ons. The
// router's password stays in a Secret of its own, out of the values anyone can read there. It goes
// with the Harvester's base (its resources are the base's children), so VMs come after it and go
// before it.

export const dnsController: ProfileBuilder<"harvester-dns-controller"> = {
    harvester({ lab, harvester: h, provider, base }, dns) {
        const login = credentials(dns.credentials);
        const c = chart("harvester-dns-controller", lab);
        const secret = new k8s.core.v1.Secret(`${h.name}/dns-controller-secret`, {
            metadata: { name: "lab-dns-controller", namespace: "harvester-system" },
            stringData: { password: pulumi.secret(login.password) },
        }, { parent: base, provider });
        const own = dns.values ?? {};
        const valuesContent = pulumi.all([login.username, base.namespace.metadata.name]).apply(([username, namespace]) => stringify({
            ...own,
            dns: {
                ...(own.dns as Record<string, unknown> | undefined),
                backend: dns.backend,
                host: dns.host,
                username,
                existingSecret: "lab-dns-controller",
                useTls: dns.useTls ?? false,
                ...(dns.tlsVerify !== undefined ? { tlsVerify: dns.tlsVerify } : {}),
                domain: lab.domain,
                ...(dns.ttl ? { ttl: dns.ttl } : {}),
                // Its records on the router, by this comment: one per Harvester, so controllers of
                // Harvesters sharing a router never clean up each other's (it takes over a record of
                // its name under another comment).
                commentTag: `managed-by=harvester-dns-controller/${h.name}`,
            },
            watchNamespaces: namespace,
        }, { lineWidth: 0 }));
        return [new HarvesterAddon(`${h.name}/dns-controller`, {
            harvester: h.name,
            name: "harvester-dns-controller",
            namespace: "harvester-system",
            labels: { "addon.harvesterhci.io/experimental": "true" },
            // An oci:// chart has no repo: Harvester's helm-controller pulls it by its reference.
            repo: c.repo ?? "",
            chart: c.chart,
            version: c.version,
            valuesContent,
            timeoutSeconds: lab.timeouts.harvesterAddon,
        }, {
            parent: base, dependsOn: [secret],
            // It was a Helm release of the same name: that one is uninstalled first, so they never
            // both run (or fight over the release name).
            aliases: [{ type: "kubernetes:helm.sh/v3:Release" }],
            deleteBeforeReplace: true,
        })];
    },
};
