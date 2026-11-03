import { createHash } from "node:crypto";
import * as pulumi from "@pulumi/pulumi";
import { Fleet, RancherServer, UiPlugins } from "@lab/rancher";
import type { ObjectValue, ResolvedLab } from "@lab/schema";
import { profileChart } from "../catalog";
import type { ProfileBuilder } from "../profiles";
import { chartValuesWithSecrets, objectValue, secretString } from "../secrets";
import { need } from "./util";

// The rancher profile: Rancher Manager on the host's cluster, its UI plugins, and Fleet (repos,
// groups, HelmOps) once the secrets they read are there.

export const rancher: ProfileBuilder<"rancher"> = {
    host(ctx, settings) {
        const { lab, host } = ctx;
        const name = `${host.name}/rancher`;
        const server = new RancherServer(name, {
            cluster: need(ctx, "kubernetes"),
            chart: profileChart("rancher", host, lab, settings.version),
            values: chartValuesWithSecrets(settings.values),
            hostname: String(profileChart("rancher", host, lab).lockedValues.hostname),
            adminPassword: secretString(settings.adminPassword),
            // A CA nothing trusts (Let's Encrypt staging): agents (imported Harvesters, downstream
            // nodes) trust Rancher through its roots, and the engine skips verifying it.
            insecure: !!lab.acme?.ca,
            privateCa: lab.acme?.ca,
            settings: settings.settings ?? {},
            features: settings.features,
            timeoutSeconds: lab.timeouts.rancherReady,
        }, { dependsOn: ctx.after });
        const rancher = server.access;

        const plugins = settings.plugins ?? lab.plugins.default;
        new UiPlugins(`${name}/plugins`, {
            rancher,
            repo: lab.plugins.repo,
            plugins: Array.isArray(plugins)
                ? Object.fromEntries(plugins.map(p => [p, lab.plugins.versions[p]])) // names checked by the resolver
                : plugins,
            timeoutSeconds: lab.timeouts.uiPlugin,
        });

        // The repos' secrets live on this cluster too (in Rancher's namespaces): after Rancher (and
        // Outrider, which its Profile uses, for SecretTemplates).
        const objects = ctx.hostObjects(rancher.cluster, [...rancher.ready, ...ctx.after]);
        const fleet = new Fleet(`${name}/fleet`, {
            rancher,
            fleet: lab.fleet[host.name],
            after: objects?.resources,
            timeoutSeconds: lab.timeouts.resourceReady,
            valuesFingerprints: valuesFingerprints(lab, host.name),
        });
        return { rancher, fleet: fleet.installs, ready: rancher.ready };
    },
};

/**
 * For each of a Rancher host's HelmOps, a number derived from the values its `valuesFrom` reads: the
 * keys of the lab's catalog Secrets on the host it names (copied downstream by Outrider), their
 * values rendered. Fleet doesn't watch those Secrets; this, as `forceSyncGeneration`, makes it
 * deploy again when one changes. Only a hash of them is stored.
 */
function valuesFingerprints(lab: ResolvedLab, host: string): Record<string, pulumi.Output<number>> {
    const leaves = (v: unknown, at: string, out: [string, pulumi.Input<string>][]) => {
        if (typeof v === "string" || (typeof v === "object" && v !== null && "$template" in v)) out.push([at, objectValue(v as ObjectValue)]);
        else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${at}[${i}]`, out));
        else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) leaves(x, `${at}.${k}`, out);
        return out;
    };
    const result: Record<string, pulumi.Output<number>> = {};
    for (const op of lab.fleet[host]?.helmOps ?? []) {
        const read: [string, pulumi.Input<string>][] = [];
        for (const ref of (op.valuesFrom ?? []) as { secretKeyRef?: { name?: string; key?: string } }[]) {
            const { name, key } = ref.secretKeyRef ?? {};
            const object = lab.objects.find(o => o.kind === "Secret" && o.name === name && "host" in o.target && o.target.host === host);
            if (object && key && key in object.data) leaves(object.data[key], `${name}/${key}`, read);
        }
        if (read.length === 0) continue;
        // 32 bits of a hash: nothing to read the values back from, so not kept secret (the HelmOp's spec stays readable).
        result[op.name] = pulumi.unsecret(pulumi.all(read.map(([at, v]) => pulumi.all([at, v]))).apply(pairs =>
            parseInt(createHash("sha256").update(JSON.stringify(pairs)).digest("hex").slice(0, 8), 16)));
    }
    return result;
}
