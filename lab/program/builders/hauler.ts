import * as pulumi from "@pulumi/pulumi";
import { HaulerRegistry } from "@lab/kubernetes";
import { download } from "../catalog";
import type { ProfileBuilder } from "../profiles";
import { secretString } from "../secrets";

// The hauler profile: Hauler's registry and fileserver as systemd services on the host, with a lego
// certificate from the lab's ACME server, its store synced from HaulManifests.

export const hauler: ProfileBuilder<"hauler"> = {
    host(ctx, settings) {
        const { lab, host } = ctx;
        // A certificate from the lab's ACME server (the resolver requires tls.cloudflare for one); plain HTTP for tls.acme: none.
        const tls = lab.acme && lab.tls.cloudflare
            ? { lego: download("lego", lab), server: lab.acme.url, email: lab.tls.email, cloudflareToken: secretString(lab.tls.cloudflare) }
            : undefined;
        if (!tls) pulumi.log.warn(`host ${host.name}: tls.acme is none; Hauler's registry speaks plain HTTP`);
        const registry = new HaulerRegistry(`${host.name}/hauler`, {
            host: ctx.access,
            hauler: download("hauler", lab, settings.version),
            manifests: Object.fromEntries(settings.manifests.map(m => [`${m}.yaml`, lab.haulManifests[m]])), // names checked by the resolver
            port: settings.port,
            fileserverPort: settings.fileserverPort,
            tls,
            after: ctx.ready,
            timeoutSeconds: lab.timeouts.haulerSync,
        }, { deletedWith: ctx.machine });
        return { ready: [registry.setup] };
    },
};
