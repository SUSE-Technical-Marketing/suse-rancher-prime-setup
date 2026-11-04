import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { activeRequirements, BUILTIN_CATALOG_DIR, capabilityReport, generateProfileSettingsTs, loadCatalog, loadLab } from "../src";

const GENERATED = path.resolve(__dirname, "..", "..", "..", "program", "generated", "profile-settings.ts");
const noPersonal = path.join(os.tmpdir(), "lab-no-such-config.yaml");

describe("profiles in the catalog", () => {
    it("are all there, with their rules and settings", () => {
        const { catalog, diagnostics } = loadCatalog({ personalConfig: noPersonal });
        expect(diagnostics.errors).toEqual([]);
        expect(Object.keys(catalog!.profiles).sort()).toEqual([
            "ai-factory", "cert-manager", "harvester-cloud-provider", "harvester-dns-controller", "hauler", "hauler-chart", "k3s", "landlock", "metallb", "mlm-client", "mlm-server",
            "open-webui", "opentelemetry", "outrider", "rancher", "rke2", "sprouter", "suse-observability-agent", "traefik", "vllm",
        ]);
        expect(catalog!.profiles.rancher).toMatchObject({ requires: ["kubernetes", "ingress", "tls", "secret-propagation"], chart: "rancher" });
        expect(catalog!.profiles.k3s).toMatchObject({ distribution: "k3s" });
        expect(catalog!.profiles.hauler.chart).toBeUndefined();
    });

    it("match the generated settings types (run `mise run profile-types` after changing them)", () => {
        const { catalog } = loadCatalog({ personalConfig: noPersonal });
        expect(fs.readFileSync(GENERATED, "utf8")).toBe(generateProfileSettingsTs(catalog!.profiles));
    });

    it("take default and locked chart values; locked paths are protected", () => {
        const { catalog } = loadCatalog({ personalConfig: noPersonal });
        expect(catalog!.profiles.rancher.charts).toMatchObject([
            { chart: "rancher", namespace: "cattle-system", lockedValues: { replicas: 1 } },
            { chart: "rancher-ai-agent", namespace: "cattle-ai-agent-system", when: expect.stringContaining("settings.liz") },
        ]);
        expect(catalog!.profiles.rancher).toMatchObject({
            chart: "rancher",
        });
        expect(catalog!.profiles.rancher.protectedValues).toEqual([
            "replicas", "hostname", "networkExposure.type", "gateway.gatewayClass.name", "gateway.gatewayClass.tls.source", "gateway.gatewayClass.tls.secretName",
            "ingress.ingressClassName", "ingress.tls.source", "ingress.tls.secretName", "privateCA", "agentTLSMode",
        ]);
        expect(catalog!.profiles.rancher.outputs).toBeUndefined();
        expect(catalog!.profiles.traefik.protectedValues).toEqual(["providers.kubernetesGateway.enabled", "service.annotations"]);
        expect(catalog!.profiles.traefik).toMatchObject({
            provides: ["ingress", "gateway-api"],
            outputs: { ingress: { ingressClassName: "traefik" }, "gateway-api": { gatewayClassName: "traefik" } },
        });
        expect(catalog!.profiles.sprouter.charts![0].values).toEqual({ excludedNamespaces: ["kube-system", "kube-public", "cattle-local-user-passwords"] });
        expect(catalog!.profiles.traefik.charts!.map(e => e.chart ?? e.manifest)).toEqual(["gateway-api", "traefik"]);
        expect(catalog!.profiles.traefik.chart).toBe("traefik");
    });

    it("check each chart entry", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-catalog-"));
        fs.cpSync(BUILTIN_CATALOG_DIR, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "profiles", "entries.yaml"), [
            "kind: Profile", "metadata: { name: entries }", "spec:", "  charts:",
            "    - { namespace: x }", "    - { chart: traefik }", "    - { manifest: gateway-api, namespace: x, values: { a: 1 } }",
            "    - { chart: traefik, namespace: t, vars: { a: b } }", "    - { manifest: traefik }", "",
        ].join("\n"));
        const { diagnostics } = loadCatalog({ personalConfig: noPersonal, catalogDir: dir });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([
            "Profile/entries.spec.charts[0]: needs exactly one of chart and manifest",
            "Profile/entries.spec.charts[1].namespace: required for a chart",
            "Profile/entries.spec.charts[2].namespace: only for a chart",
            "Profile/entries.spec.charts[2].values: only for a chart",
            "Profile/entries.spec.charts[3].vars: only for a manifest",
            'Profile/entries.spec.charts[4].manifest: no Manifest "traefik"',
        ]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("report a broken settings schema, and references to missing components", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-catalog-"));
        fs.cpSync(BUILTIN_CATALOG_DIR, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "profiles", "broken.yaml"), [
            "apiVersion: lab.geeko.me/v1alpha1", "kind: Profile", "metadata: { name: broken }", "spec:", "  charts: [ { chart: nope, namespace: x } ]",
            "  settings:", "    type: object", "    required: [missing]", "    properties:", "      a: { type: nope }", "      b: { type: string, format: email }",
            "      c: { type: secret, suggest: appco }", "      d: { type: string, suggest: \"{{ secrets.appco }}\" }", "",
        ].join("\n"));
        const { diagnostics } = loadCatalog({ personalConfig: noPersonal, catalogDir: dir });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([
            'Profile/broken.spec.settings.properties.a.type: unknown type "nope"; one of string, integer, number, boolean, object, array, dnsLabel, dnsName, quantity, ipv4, address, url, secret, credentials, chartValues, haulManifest',
            'Profile/broken.spec.settings.properties.b.format: unsupported keyword "format"',
            'Profile/broken.spec.settings.properties.c.suggest: must be a secret template, e.g. "{{ secrets.appco }}"',
            'Profile/broken.spec.settings.properties.d.suggest: is for a secret or credentials setting',
            'Profile/broken.spec.settings.required: "missing" isn\'t one of the settings',
            'Profile/broken.spec.charts[0].chart: no HelmChart "nope"',
        ]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe("profile templates", () => {
    it("report undefined variables and syntax errors with the value's path and the host", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-catalog-"));
        fs.cpSync(BUILTIN_CATALOG_DIR, dir, { recursive: true });
        const sprouter = path.join(dir, "profiles", "sprouter.yaml");
        fs.writeFileSync(sprouter, fs.readFileSync(sprouter, "utf8").replace("      namespace: sprouter\n",
            "      namespace: sprouter\n      lockedValues:\n        a: \"{{ settings.nope }}\"\n        b: \"{{ host.fqdn \"\n        c: \"{{ outputs.tls.secretName }}\"\n"));
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-tpl-"));
        const labFile = path.join(tmp, "lab.yaml");
        fs.writeFileSync(labFile, [
            "kind: Lab", "metadata: { name: t }", "spec:", "  domain: lab.example.com", "  tls: { acme: none }",
            '  ssh: { user: lab, publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.k }}" }',
            "---", "kind: Harvester", "metadata: { name: hv }", "spec: { url: https://hv.example.com, credentials: { username: a, password: b } }",
            "---", "kind: HarvesterVM", "metadata: { name: vm }", "spec: { harvester: hv, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { k3s: {}, sprouter: {} } }", "",
        ].join("\n"));
        const result = loadLab({ labFile, personalConfig: noPersonal, catalogDir: dir });
        expect(result.diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([
            "ChartProfile/sprouter.spec.charts[0].lockedValues.a: template: attempted to output null or undefined value (on host vm)",
            "ChartProfile/sprouter.spec.charts[0].lockedValues.b: template: expected variable end (on host vm)",
            // sprouter doesn't require tls: a template only sees the outputs of what its profile waits for.
            "ChartProfile/sprouter.spec.charts[0].lockedValues.c: template: attempted to output null or undefined value (on host vm)",
        ]);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});

describe("requiresWhen", () => {
    it("requires a capability when a setting is set, or has a value", () => {
        const { catalog } = loadCatalog({ personalConfig: noPersonal });
        const rancher = catalog!.profiles.rancher;
        expect(activeRequirements(rancher, { exposure: "gateway" })).toContain("gateway-api");
        expect(activeRequirements(rancher, { exposure: "auto" })).not.toContain("gateway-api");
        expect(activeRequirements(rancher, { exposure: "ingress" })).not.toContain("gateway-api");
    });
});


describe("capability reports", () => {
    const { catalog } = loadCatalog({ personalConfig: "/nonexistent/lab-config.yaml" });
    const registry = catalog!.profiles;
    const fleetKnown = Object.fromEntries(Object.entries(catalog!.fleet.profiles).map(([n, { value }]) => [n, value]));

    it("say what a host's profiles need that none of the others provides (fallbacks counting)", () => {
        const report = capabilityReport(registry, "host", { k3s: {}, sprouter: {}, rancher: { adminPassword: "x" } });
        // k3s's own Traefik is the ingress; nothing issues certificates.
        expect(report.provided).toContain("ingress");
        expect(report.needs).toEqual(["tls"]);
        expect(capabilityReport(registry, "host", { k3s: {}, "cert-manager": {}, sprouter: {}, rancher: { adminPassword: "x" } }).needs).toEqual([]);
    });

    it("count a cluster's kubernetes and its Fleet profiles among themselves; a Harvester only has kubernetes", () => {
        expect(capabilityReport(registry, "cluster", { sprouter: {} }).needs).toEqual([]);
        expect(capabilityReport(registry, "cluster", {}, { names: ["observability"], known: fleetKnown }).needs).toEqual(["storage"]);
        expect(capabilityReport(registry, "cluster", {}, { names: ["observability", "storage"], known: fleetKnown })).toMatchObject({ needs: [] });
        expect(capabilityReport(registry, "harvester", { "harvester-dns-controller": {} }).provided).toEqual(["harvester-dns-controller", "kubernetes"]);
    });
});
