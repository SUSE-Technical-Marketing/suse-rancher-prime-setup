// The resolver's shared state (DESIGN.md §7.1): what the phases read and fill in, and the helpers
// they share. Created with the catalog step: secrets bookkeeping, the catalog, OS profiles.

import * as path from "node:path";
import { catalogValues, resolveCatalog } from "../catalog";
import type { Diagnostics } from "../diagnostics";
import { docAt } from "../documents";
import type { ResolvedFleet } from "../fleet";
import { haulManifestFiles, renderHaulManifest } from "../hauler";
import { createObjects } from "../objects";
import type { ResolvedOs } from "../os";
import type { Profiles } from "../profiles";
import { activeRequirements, describeCapability, hostCapabilities } from "../profiles/rules";
import { profileTargets } from "../profiles/define";
import type { FixedAddress, RenderedProfile, ResolvedAwsSite, ResolvedDownstream, ResolvedHarvester, ResolvedHost, ResolveInput } from "../resolve";
import { AWS_CREDENTIAL_FIELDS, type AwsCredentials, type Credentials } from "../schema";
import { checkSecretTemplate, describeShape, mapShape, mergeShapes, type SecretShape, usesSecrets } from "../secrets";
import { valuesOfType } from "../settings-schema";
import { isTemplate, renderTemplates, type TemplateContext } from "../templates";
import { inCidr, nthAddress, toInt } from "../net";

export type Resolution = ReturnType<typeof createResolution>;

export function createResolution(input: ResolveInput, diags: Diagnostics) {
    const { lab, labSource: L, personal, personalSource: P } = input;
    const secrets: Record<string, SecretShape> = {};

    const expand = (p: string, baseDir: string) => {
        const home = p === "~" || p.startsWith("~/") ? path.join(input.home, p.slice(1)) : p;
        return path.resolve(baseDir, home);
    };

    const needSecret = (name: string, shape: SecretShape, source: string, at: string) => {
        const existing = secrets[name];
        const merged = existing ? mergeShapes(existing, shape) : shape;
        if (!merged) {
            diags.error(source, at, `secret "${name}" is used both as ${describeShape(existing!)} and as ${describeShape(shape)}`);
            return;
        }
        secrets[name] = merged;
    };

    /** Where the lab file's secrets are filled in (secret fields, chart values): a secret anywhere else is text. */
    const secretSites = new Set<string>();

    /** A template that may use secrets: report what's wrong with it, register the secrets it uses. */
    const useTemplate = (template: string, shape: SecretShape, source: string, at: string, vars?: Record<string, unknown>) => {
        if (source === L) secretSites.add(at);
        const { uses, error } = checkSecretTemplate(template, shape, vars);
        if (error) diags.error(source, at, error);
        for (const u of uses) needSecret(u.name, u.shape, source, at);
    };

    const PLAIN = "secret value is written in the lab file; use a secret (\"{{ secrets.name }}\") before sharing it";

    /** A secret field: a template over `secrets`, or a plain value (a warning in the lab file). */
    const useSecretOrString = (v: string | undefined, source: string, at: string) => {
        if (v === undefined) return;
        if (isTemplate(v)) useTemplate(v, "string", source, at);
        else if (source === L) diags.warning(source, at, PLAIN);
    };

    /** Credentials: one secret ("{{ secrets.harbor }}"), or a username with a password. */
    const useCredentials = (creds: Credentials, source: string, at: string) => {
        if (typeof creds === "string") {
            if (isTemplate(creds)) useTemplate(creds, "credentials", source, at);
            else diags.error(source, at, "credentials are one secret (\"{{ secrets.name }}\") or { username, password }");
            return;
        }
        if (isTemplate(creds.username)) useTemplate(creds.username, "string", source, `${at}.username`);
        useSecretOrString(creds.password, source, `${at}.password`);
    };

    /** AWS keys: one secret holding `accessKey` and `secretKey`, or the two fields. */
    const useAwsCredentials = (creds: AwsCredentials, source: string, at: string) => {
        if (typeof creds === "string") {
            if (isTemplate(creds)) useTemplate(creds, mapShape(AWS_CREDENTIAL_FIELDS), source, at);
            else diags.error(source, at, `AWS credentials are one secret ("{{ secrets.name }}") or { ${AWS_CREDENTIAL_FIELDS.join(", ")} }`);
            return;
        }
        for (const f of AWS_CREDENTIAL_FIELDS) useSecretOrString(creds[f], source, `${at}.${f}`);
    };

    /** Register the secrets in free-form values (chart values): every string that uses `secrets`. */
    const walkRefs = (value: unknown, at: string): void => {
        if (typeof value === "string") { if (usesSecrets(value)) useTemplate(value, "string", L, at); }
        else if (Array.isArray(value)) value.forEach((v, i) => walkRefs(v, `${at}[${i}]`));
        else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walkRefs(v, `${at}.${k}`);
    };

    // --- Catalog: versions and OS profiles ------------------------------------------------------
    const catalog = resolveCatalog([
        ...input.catalogLayers,
    ], diags);
    const allOs = catalogValues(catalog.os);
    const acme = lab.tls.acme === "none" ? undefined : catalog.acme[lab.tls.acme]?.value;
    if (lab.tls.acme !== "none" && !acme) {
        diags.error(L, "tls.acme", `no AcmeServer "${lab.tls.acme}"; known: ${[...Object.keys(catalog.acme).sort(), "none"].join(", ")}`);
    }
    const usedOs: Record<string, ResolvedOs> = {};
    const useOs = (name: string, at: string): ResolvedOs | undefined => {
        const os = allOs[name];
        if (!os) {
            diags.error(L, at, `unknown OS profile "${name}"; known: ${Object.keys(allOs).sort().join(", ") || "none"}`);
            return undefined;
        }
        if (!usedOs[name]) {
            usedOs[name] = os;
            // Rendered for real by the program, with the secrets' values; this checks the templates and
            // finds the secrets they use (a registration code, say).
            const vars = { lab: { name: lab.lab, domain: lab.domain, vars: lab.vars } };
            const walk = (value: unknown, at: string): void => {
                if (typeof value === "string") { if (isTemplate(value)) useTemplate(value, "string", `OS profile ${name}`, at, vars); }
                else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`));
                else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`);
            };
            walk(os.cloudInit, "cloudInit");
            walk(os.harvester, "harvester.cloudInit");
            walk(os.kubernetes, "kubernetes.cloudInit");
        }
        return os;
    };

    // Defaults the phases fill in where the lab doesn't say.
    const hvDefaults = catalog.defaults.value.harvester;
    const vmDefaults = catalog.defaults.value.vm;
    const awsDefaults = catalog.defaults.value.aws;
    const harvesters = new Map<string, ResolvedHarvester>();
    const awsSites = new Map<string, ResolvedAwsSite>();

    const checkNetwork = (harvester: ResolvedHarvester, network: string | undefined, at: string): string => {
        const name = network ?? harvester.defaultNetwork;
        // `namespace/name`: a network already on the Harvester, which the lab doesn't declare.
        if (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name)) return name;
        if (!harvester.networks.some(n => n.name === name)) {
            diags.error(L, at, `network "${name}" doesn't exist on harvester "${harvester.name}"; known: ${harvester.networks.map(n => n.name).join(", ")}`);
        }
        return name;
    };

    // OS name -> Harvester names it's needed on, to work out images afterwards.
    const imagesNeeded = new Map<string, Set<string>>();
    const needImage = (harvester: string, os: string) => {
        const set = imagesNeeded.get(harvester) ?? new Set<string>();
        // Variants (`extends`) without an image of their own share their parent's.
        set.add(allOs[os]?.image ?? os);
        imagesNeeded.set(harvester, set);
    };

    const registry = catalog.profiles;
    const usedHaulManifests = new Set<string>();
    /** Profiles the lab uses that the engine doesn't build yet. */
    const plannedProfiles = new Set<string>();
    /** A host's `profiles:`: known names, settings checked against each profile's schema. */
    const parseProfiles = (profiles: Record<string, Record<string, unknown>>, at: string): Profiles => {
        const result: Profiles = {};
        for (const [name, settings] of Object.entries(profiles)) {
            const def = registry[name];
            if (!def) {
                diags.error(L, `${at}.profiles`, `unknown profile "${name}"; known: ${Object.keys(registry).sort().join(", ")}`);
                continue;
            }
            const parsed = def.settings.safeParse(settings ?? {});
            if (!parsed.success) {
                diags.addZodError(L, parsed.error, [...at.split("."), "profiles", name]);
                continue;
            }
            result[name] = parsed.data as Record<string, unknown>;
            if (def.status === "planned") {
                plannedProfiles.add(name);
                diags.warning(L, `${at}.profiles.${name}`, "isn't built yet (status: planned): the lab validates with it, but `lab up` refuses it");
            }
            // Settings naming a HaulManifest: the catalog must have it; the lab gets it rendered.
            for (const ref of valuesOfType(def.settingsSchema, parsed.data, "haulManifest")) {
                const manifest = String(ref.value);
                if (catalog.haulManifests[manifest]) usedHaulManifests.add(manifest);
                else diags.error(L, `${at}.profiles.${name}.${ref.at}`, `no HaulManifest "${manifest}"; known: ${Object.keys(catalog.haulManifests).sort().join(", ") || "none"}`);
            }
        }
        return result;
    };
    const hosts = new Map<string, ResolvedHost>();

    /**
     * A profile's charts and objects on a host or downstream cluster, their templates rendered
     * (§17); undefined when it has neither, or misses requirements (the rules report those).
     */
    const renderedHaul = Object.fromEntries(Object.entries(catalog.haulManifests).map(([n, { value }]) => [n, renderHaulManifest(n, value)]));
    const renderProfile = (
        name: string, profiles: Profiles, outputs: Record<string, Record<string, unknown>>,
        where: Pick<TemplateContext, "host" | "target">, on: string,
    ): RenderedProfile | undefined => {
        const def = registry[name];
        if (!def?.charts?.length && !def?.objects?.length) return undefined;
        // Missing requirements are reported by the profile rules; its templates would only add noise.
        const caps = hostCapabilities(registry, profiles);
        if (where.target.kind !== "host") caps.set("kubernetes", [`the ${where.target.kind}`]);
        if (activeRequirements(def, profiles[name]).some(c => !caps.has(c))) return undefined;
        // Only what the profile waits for: a template can't read a profile built after it.
        const waitFor = new Set([...(def.requires ?? []), ...(def.uses ?? []), ...(def.requiresWhen ?? []).map(r => r.capability)]);
        const ctx: TemplateContext = {
            settings: profiles[name],
            ...where,
            lab: {
                name: lab.lab, domain: lab.domain, vars: lab.vars,
                tls: {
                    acme: lab.tls.acme, privateCA: !!acme?.ca,
                    ...(acme ? { url: acme.url } : {}),
                    ...(lab.tls.email ? { email: lab.tls.email } : {}),
                    // A secret template ("{{ secrets.cloudflare.token }}"), rendered with its value when the lab is built.
                    ...(lab.tls.cloudflare ? { cloudflare: lab.tls.cloudflare } : {}),
                },
            },
            outputs: Object.fromEntries(Object.entries(outputs).filter(([cap]) => waitFor.has(cap))),
            haulManifests: names => haulManifestFiles(names, renderedHaul),
        };
        const errorAt = (part: string) => (path: string, message: string) =>
            diags.error(def.source, docAt(def.kind === "chart" ? "ChartProfile" : "Profile", name, `spec.${part}${path ? `.${path}` : ""}`), `${message} (on ${on})`);
        return {
            entries: (def.charts ?? []).map((e, i) => {
                const error = (field: string) => errorAt(`charts[${i}].${field}`);
                const install = e.when === undefined ? true : renderTemplates(e.when, ctx, "", error("when"));
                if (typeof install !== "boolean") error("when")("", `must render to true or false, not ${JSON.stringify(install)}`);
                const version = e.version === undefined ? undefined : renderTemplates(e.version, ctx, "", error("version"));
                return {
                    values: renderTemplates(e.values ?? {}, ctx, "", error("values")) as Record<string, unknown>,
                    lockedValues: renderTemplates(e.lockedValues ?? {}, ctx, "", error("lockedValues")) as Record<string, unknown>,
                    install: install === true,
                    ...(typeof version === "string" && version !== "" ? { version } : {}),
                    vars: Object.fromEntries(Object.entries(e.vars ?? {}).map(([k, v]) => [k, String(renderTemplates(v, ctx, "", error(`vars.${k}`)))])),
                };
            }),
            objects: (def.objects ?? []).flatMap((e, i) => {
                const error = (field: string) => errorAt(`objects[${i}].${field}`);
                const create = e.when === undefined ? true : renderTemplates(e.when, ctx, "", error("when"));
                if (typeof create !== "boolean") error("when")("", `must render to true or false, not ${JSON.stringify(create)}`);
                if (create !== true) return [];
                const object = renderTemplates(e.object, ctx, "", error("object")) as Record<string, unknown>;
                const aliases = (e.aliases ?? []).map((a, j) => String(renderTemplates(a, ctx, "", error(`aliases[${j}]`))));
                return [{
                    name: String(renderTemplates(e.name, ctx, "", error("name"))), object,
                    ...(e.admitted ? { admitted: true } : {}), ...(e.wait ? { wait: e.wait } : {}), ...(aliases.length ? { aliases } : {}),
                }];
            }),
            aliases: (def.aliases ?? []).map((a, i) => typeof a === "string" ? { type: a } : {
                ...(a.type ? { type: a.type } : {}),
                ...(a.name ? { name: String(renderTemplates(a.name, ctx, "", errorAt(`aliases[${i}].name`))) } : {}),
            }),
        };
    };
    /**
     * A VM's or a one-machine pool's fixed address (`ip`), set in the VM itself, on a lab network (its subnet from the network)
     * or one already on the Harvester (with its prefix and gateway): inside the subnet, outside its
     * DHCP range and load-balancer pool, not one of its own addresses, and unique in the lab. A VM
     * without one gets its address from DHCP: the lab's, or one already on the network (the LAN's).
     */
    const fixedTaken = new Map<string, string>();
    const fixedAddress = (harvester: ResolvedHarvester, network: string, h: { ip?: string; gateway?: string; dns?: string[] }, at: string): { ip?: FixedAddress } => {
        const net = harvester.networks.find(n => n.name === network);
        const existing = network.includes("/");
        if (!h.ip) {
            for (const f of ["gateway", "dns"] as const) if (h[f] !== undefined) diags.error(L, `${at}.${f}`, "only goes with ip");
            return {};
        }
        const [address, prefixText] = h.ip.split("/");
        if (address.split(".").some(o => Number(o) > 255)) {
            diags.error(L, `${at}.ip`, `${address} isn't an IPv4 address`);
            return {};
        }
        let subnet: { cidr: string; gateway: string; dns: string[] };
        if (existing) {
            // The lab doesn't know this network: the VM says what it looks like.
            if (!prefixText) diags.error(L, `${at}.ip`, `needs its prefix (${address}/24) on ${network}, a network the lab doesn't declare`);
            if (!h.gateway) diags.error(L, `${at}.gateway`, `required with ip on ${network}, a network the lab doesn't declare`);
            if (!prefixText || !h.gateway) return {};
            subnet = { cidr: `${nthAddress(`${address}/${prefixText}`, 0)}/${prefixText}`, gateway: h.gateway, dns: h.dns ?? [h.gateway] };
        } else {
            for (const f of ["gateway", "dns"] as const) if (h[f] !== undefined) diags.error(L, `${at}.${f}`, `comes from the network ${network}; set it there`);
            if (!net) return {}; // reported by checkNetwork
            if (!net.subnet) {
                diags.error(L, `${at}.ip`, `${network} has neither lab DHCP nor a cidr: give the network cidr and gateway`);
                return {};
            }
            subnet = net.subnet;
            const bits = subnet.cidr.split("/")[1];
            if (prefixText !== undefined && prefixText !== bits) diags.error(L, `${at}.ip`, `/${prefixText} doesn't match ${network}'s ${subnet.cidr}; leave the prefix out`);
        }
        const prefix = Number(subnet.cidr.split("/")[1]);
        const problem = !inCidr(address, subnet.cidr) ? `${address} is outside ${network}'s ${subnet.cidr}`
            : address === nthAddress(subnet.cidr, 0) ? `${address} is the network's own address`
            : address === nthAddress(subnet.cidr, 2 ** (32 - prefix) - 1) ? `${address} is the network's broadcast address`
            : address === subnet.gateway ? `${address} is the gateway`
            : address === net?.dhcp?.server ? `${address} is the DHCP server`
            : net?.dhcp && toInt(address) >= toInt(net.dhcp.range[0]) && toInt(address) <= toInt(net.dhcp.range[1]) ? `${address} is in the DHCP range ${net.dhcp.range[0]}-${net.dhcp.range[1]}; a fixed address goes outside it`
            : net?.loadBalancer && toInt(address) >= toInt(net.loadBalancer.range[0]) && toInt(address) <= toInt(net.loadBalancer.range[1]) ? `${address} is in the load-balancer pool ${net.loadBalancer.range[0]}-${net.loadBalancer.range[1]}`
            : undefined;
        if (problem) {
            diags.error(L, `${at}.ip`, problem);
            return {};
        }
        const key = `${harvester.name}/${network}/${address}`;
        const other = fixedTaken.get(key);
        if (other) diags.error(L, `${at}.ip`, `${address} is ${other}'s fixed address too`);
        fixedTaken.set(key, at.replace(/^hosts\./, "").replace(/^downstream\./, "cluster "));
        return { ip: { address, prefix, gateway: subnet.gateway, dns: subnet.dns } };
    };
    const describe = (capability: string) => describeCapability(registry, capability);
    // Profiles that go on downstream clusters, or Harvesters (for the errors listing them).
    const forTarget = (t: "cluster" | "harvester") => Object.values(registry).filter(p => profileTargets(p).includes(t)).map(p => p.name).sort();
    const downstream: ResolvedDownstream[] = [];
    const fleet: Record<string, ResolvedFleet> = {};

    return {
        input, lab, L, P, personal, diags,
        secrets, secretSites, expand, needSecret, useTemplate, useSecretOrString, useCredentials, useAwsCredentials, walkRefs,
        catalog, registry, allOs, acme, usedOs, useOs, hvDefaults, vmDefaults, awsDefaults,
        harvesters, awsSites, hosts, downstream, fleet,
        checkNetwork, fixedAddress, imagesNeeded, needImage, usedHaulManifests, plannedProfiles, parseProfiles, renderedHaul, renderProfile, describe, forTarget,
        /** The lab's secrets and configmaps: created by the objects phase, placed by later ones. */
        objects: undefined as unknown as ReturnType<typeof createObjects>,
    };
}
