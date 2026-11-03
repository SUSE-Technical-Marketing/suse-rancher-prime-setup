// Checks across the whole lab, once everything is resolved: profiles' own checks and the clusters
// their settings name, the images each Harvester needs, and the lab's top-level fields.

import { awsFootprint } from "../clusters";
import { clusterNodeOs } from "../clusters";
import type { LabFeature } from "../primitives";
import type { ResolvedDownstream, ResolvedLab } from "../resolve";
import type { ImageSource } from "../schema";
import { usesSecrets } from "../secrets";
import type { Resolution } from "./context";

/** What profiles declare they need (of the lab, of their nodes' OS, of a cluster's type), and the downstream clusters their settings name. */
export function checkProfiles(r: Resolution): void {
    const { lab, L, diags, catalog, registry, allOs, hosts, downstream, harvesters } = r;
    const fleetCaps = (d: ResolvedDownstream) => Object.keys(d.fleetProfiles ?? {}).flatMap(n => [n, ...(catalog.fleet.profiles[n]?.value.provides ?? [])]);
    const checkClusterRefs = (profiles: Record<string, Record<string, unknown>>, at: string) => {
        for (const [n, settings] of Object.entries(profiles)) {
            for (const ref of registry[n]?.clusterRefs ?? []) {
                const name = ref.field.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], settings);
                if (typeof name !== "string") continue;
                const path = `${at}.profiles.${n}.${ref.field}`;
                const d = downstream.find(x => x.name === name);
                if (!d) diags.error(L, path, `no downstream cluster "${name}" in the lab; clusters: ${downstream.map(x => x.name).join(", ") || "none"}`);
                else if (!fleetCaps(d).includes(ref.provides)) {
                    const providing = Object.entries(catalog.fleet.profiles).filter(([fp, { value }]) => [fp, ...(value.provides ?? [])].includes(ref.provides)).map(([fp]) => fp);
                    diags.error(L, path, `cluster ${name} doesn't run ${ref.provides}: give it the Fleet profile ${providing.join(" or ") || `that provides ${ref.provides}`}`);
                }
            }
        }
    };
    // --- What profiles declare they need of the lab and of their nodes' OS (§7.6) -------------------
    const LAB_NEEDS: Record<LabFeature, { missing: () => boolean; message: string }> = {
        acme: { missing: () => lab.tls.acme === "none", message: "needs the lab's ACME server; set tls.acme (and tls.email, tls.cloudflare), not none" },
    };
    const needsOs = (name: string, os: string, at: string) => {
        for (const feature of registry[name]?.osFeatures ?? []) {
            if (allOs[os] && allOs[os][feature] === undefined) diags.error(L, at, `OS profile ${os} has no ${feature} section, which the ${name} profile needs`);
        }
    };
    const needsLab = (name: string, at: string) => {
        for (const feature of registry[name]?.labRequires ?? []) if (LAB_NEEDS[feature].missing()) diags.error(L, at, LAB_NEEDS[feature].message);
    };
    for (const host of hosts.values()) {
        for (const name of Object.keys(host.profiles)) {
            const at = `hosts.${host.name}.profiles.${name}`;
            needsLab(name, at);
            needsOs(name, host.os, at);
        }
    }
    for (const d of downstream) {
        for (const name of Object.keys(d.chartProfiles?.profiles ?? {})) {
            const at = `downstream.${d.name}.profiles.${name}`;
            const notOn = registry[name]?.notOnClusterTypes?.[d.type];
            if (notOn) diags.error(L, at, `can't go on a ${d.type} cluster: ${notOn}`);
            needsLab(name, at);
            // Every node: a cluster's machines', or a metal cluster's hosts'.
            for (const node of clusterNodeOs(d, host => hosts.get(host)?.os, at)) needsOs(name, node.os, node.at);
        }
    }
    for (const h of harvesters.values()) for (const name of Object.keys(h.profiles)) needsLab(name, `harvesters.${h.name}.profiles.${name}`);

    for (const host of hosts.values()) checkClusterRefs(host.profiles, `hosts.${host.name}`);
    for (const d of downstream) checkClusterRefs(d.chartProfiles?.profiles ?? {}, `downstream.${d.name}`);
    for (const h of harvesters.values()) checkClusterRefs(h.profiles, `harvesters.${h.name}`);
}

/** The OS images each Harvester needs, and where each comes from. */
export function resolveImages(r: Resolution): void {
    const { input, lab, L, P, personal, diags, allOs, harvesters, imagesNeeded, expand } = r;
    for (const [harvesterName, osNames] of imagesNeeded) {
        const harvester = harvesters.get(harvesterName)!;
        for (const osName of [...osNames].sort()) {
            const os = allOs[osName];
            if (!os) continue; // already reported
            const fromLab: ImageSource | undefined = lab.images[osName];
            const fromPersonal: ImageSource | undefined = personal.images[osName];
            const chosen = fromLab ? { src: fromLab, source: L, dir: input.labDir } : fromPersonal ? { src: fromPersonal, source: P, dir: input.personalDir } : undefined;
            if (!chosen) {
                if (os.imageUrl) {
                    harvester.images.push({ os: osName, source: { kind: "url", url: os.imageUrl } });
                } else {
                    diags.error(L, `images.${osName}`, `OS "${osName}" has no public image; add images.${osName} with a url or a local file, here or in the personal config`);
                }
                continue;
            }
            if ("url" in chosen.src) {
                harvester.images.push({ os: osName, source: { kind: "url", url: chosen.src.url } });
            } else {
                const file = expand(chosen.src.file, chosen.dir);
                if (!input.fs.exists(file)) diags.error(chosen.source, `images.${osName}.file`, `file not found: ${file}`);
                harvester.images.push({ os: osName, source: { kind: "file", path: file } });
            }
        }
    }
}

/** The lab's vars, TLS and SSH, unused Harvesters and sites, and secrets used as text; returns the lab's SSH settings. */
export function checkTopLevel(r: Resolution): ResolvedLab["ssh"] {
    const { input, lab, L, diags, catalog, hosts, downstream, harvesters, awsSites, secretSites, expand, useTemplate, useSecretOrString } = r;
    const walkVars = (value: unknown, at: string): void => {
        if (typeof value === "string") { if (usesSecrets(value)) useTemplate(value, "string", L, at); }
        else if (Array.isArray(value)) value.forEach((v, i) => walkVars(v, `${at}[${i}]`));
        else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walkVars(v, `${at}.${k}`);
    };
    walkVars(lab.vars, "vars");

    const anyHosts = hosts.size > 0;
    if (anyHosts && lab.tls.acme !== "none") {
        if (!lab.tls.email) diags.error(L, "tls.email", `required for ACME (tls.acme: ${lab.tls.acme})`);
        if (!lab.tls.cloudflare) diags.error(L, "tls.cloudflare", `required for ACME DNS-01, e.g. "{{ secrets.cloudflare.token }}"`);
    }
    useSecretOrString(lab.tls.cloudflare, L, "tls.cloudflare");

    let ssh: ResolvedLab["ssh"];
    if (lab.ssh) {
        useSecretOrString(lab.ssh.privateKey, L, "ssh.privateKey");
        let publicKey = typeof lab.ssh.publicKey === "string" ? lab.ssh.publicKey : "";
        if (typeof lab.ssh.publicKey !== "string") {
            const file = expand(lab.ssh.publicKey.file, input.labDir);
            if (input.fs.exists(file)) publicKey = input.fs.read(file).trim();
            else diags.error(L, "ssh.publicKey.file", `file not found: ${file}`);
        }
        ssh = { user: lab.ssh.user ?? catalog.defaults.value.ssh.user, publicKey, privateKey: lab.ssh.privateKey };
    } else if (anyHosts) {
        diags.error(L, "ssh", "required when the lab has hosts (user, publicKey, privateKey)");
    }

    const usedSites = new Set(downstream.flatMap(d => awsFootprint(d)?.site ?? []));
    for (const name of awsSites.keys()) {
        if (!usedSites.has(name)) diags.warning(L, `awsSites.${name}`, "no downstream cluster uses it; the lab still creates its VPC there");
    }

    const usedHarvesters = new Set([
        ...[...hosts.values()].flatMap(h => h.kind === "harvester" ? [h.harvester] : []),
        ...downstream.flatMap(d => d.type === "harvester" ? [d.harvester] : []),
    ]);
    for (const name of harvesters.keys()) {
        if (!usedHarvesters.has(name)) {
            diags.warning(L, `harvesters.${name}`, "no host or downstream cluster uses it; it is still claimed and gets the lab's base resources");
        }
    }

    // Secrets only get their values where they're filled in; anywhere else (an annotation, an
    // address) the lab would use the template as text. `vars` are a source: what refers to them is checked.
    const walkSecretText = (value: unknown, at: string): void => {
        if (typeof value === "string") {
            if (usesSecrets(value) && !secretSites.has(at)) {
                diags.error(L, at, "uses a secret, but this field isn't filled in with secrets: the template would be used as text. Secrets go in secret fields (passwords, credentials, tokens) and in chart values");
            }
        } else if (Array.isArray(value)) value.forEach((v, i) => walkSecretText(v, `${at}[${i}]`));
        else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walkSecretText(v, `${at}.${k}`);
    };
    // Only on an otherwise clean lab: a field whose document has errors may not have been looked at.
    if (diags.ok) for (const key of ["tls", "ssh", "inputs", "images", "harvesters", "awsSites", "hosts", "downstream"] as const) walkSecretText(lab[key], key);
    return ssh;
}
