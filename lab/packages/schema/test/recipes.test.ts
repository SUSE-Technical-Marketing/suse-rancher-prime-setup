import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { BUILTIN_CATALOG_DIR, loadCatalog, loadLab } from "../src";

const noPersonal = path.join(os.tmpdir(), "lab-no-personal-config.yaml");

describe("host recipes", () => {
    it("are in the built-in catalog", () => {
        const { catalog, diagnostics } = loadCatalog({ personalConfig: noPersonal });
        expect(diagnostics.errors).toEqual([]);
        expect(Object.keys(catalog!.recipes).sort()).toEqual(["rancher-vm", "registry-vm"]);
        expect(catalog!.recipes["rancher-vm"].value).toMatchObject({ kind: "HarvesterVM", name: "rancher", host: { cpu: 4, memory: "8Gi" } });
    });

    it("make hosts that resolve, once the composer has filled in what the personal config gives", () => {
        const { catalog } = loadCatalog({ personalConfig: noPersonal });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-recipes-"));
        // As the composer adds them: the recipe's host, on a Harvester, Rancher's admin password from a secret.
        const filled: Record<string, Record<string, unknown>> = { rancher: { adminPassword: "{{ secrets['rancher-admin'] }}" } };
        const docs = Object.entries(catalog!.recipes).map(([name, { value }]) => ({
            apiVersion: "lab.geeko.me/v1alpha1", kind: value.kind, metadata: { name: value.name ?? name },
            spec: {
                harvester: "hv", os: "leap-16", ...value.host,
                profiles: Object.fromEntries(Object.entries(value.host.profiles).map(([p, s]) => [p, { ...filled[p], ...s }])),
            },
        }));
        const lab = [
            { apiVersion: "lab.geeko.me/v1alpha1", kind: "Lab", metadata: { name: "recipes" }, spec: {
                domain: "lab.example.com", tls: { acme: "letsencrypt-staging", email: "a@b.cd", cloudflare: "{{ secrets.cf }}" },
                ssh: { publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.key }}" } } },
            { apiVersion: "lab.geeko.me/v1alpha1", kind: "Harvester", metadata: { name: "hv" }, spec: { url: "https://hv.example.com", credentials: "{{ secrets.hv }}" } },
            ...docs,
        ].map(d => stringify(d)).join("---\n");
        fs.writeFileSync(path.join(dir, "lab.yaml"), lab);
        const { diagnostics } = loadLab({ labFile: path.join(dir, "lab.yaml"), personalConfig: noPersonal });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("are checked against the catalog's profiles and OS profiles; settings left out are fine", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-catalog-"));
        fs.cpSync(BUILTIN_CATALOG_DIR, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "recipes", "broken.yaml"), `apiVersion: lab.geeko.me/v1alpha1
kind: HostRecipe
metadata: { name: broken }
spec:
  kind: Machine
  host:
    memory: 8Gi
    os: nope
    profiles:
      nope: {}
      harvester-cloud-provider: {}
      hauler: { port: 70000 }
      rancher: { hostname: rancher }
`);
        const { diagnostics } = loadCatalog({ personalConfig: noPersonal, catalogDir: dir });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([
            "HostRecipe/broken.spec.host.memory: doesn't apply to a Machine",
            'HostRecipe/broken.spec.host.os: unknown OS "nope"; known: leap-16, rocky-9, sl-micro-6.1, sles-16, ubuntu-24.04',
            expect.stringMatching(/^HostRecipe\/broken\.spec\.host\.profiles: unknown profile "nope"; known: ai-factory, /),
            "HostRecipe/broken.spec.host.profiles.harvester-cloud-provider: only runs on harvester hosts, not a Machine",
            "HostRecipe/broken.spec.host.profiles.hauler.port: Too big: expected number to be <=65535",
        ]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
