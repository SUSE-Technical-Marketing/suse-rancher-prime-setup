import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { BUILTIN_CATALOG_DIR, loadCatalog, loadLab, recipeDropsOn, renderRecipe, type RecipeVars } from "../src";

const noPersonal = path.join(os.tmpdir(), "lab-no-personal-config.yaml");
const vars = (v: Partial<RecipeVars> = {}): RecipeVars => ({ drop: {}, names: {}, ...v });

describe("recipe variables", () => {
    it("fill in whole values, text, and leave out what's unset", () => {
        expect(renderRecipe({
            harvester: "${ drop.harvester }", network: "${ drop.network }", rancher: "${rancher}",
            hostname: "rancher.${ drop.harvester }.example.com", lab: "{{ lab.domain }}",
            observer: "${ names.obs }", list: ["${ os }", "${ drop.site }", "x"],
        }, vars({ drop: { harvester: "asgard" }, rancher: "odin", os: "leap-16", names: { obs: "observability-2" } }))).toEqual({
            harvester: "asgard", rancher: "odin", hostname: "rancher.asgard.example.com",
            // A lab template is the lab's: copied as it is.
            lab: "{{ lab.domain }}",
            observer: "observability-2", list: ["leap-16", "x"],
        });
    });
});

describe("recipes", () => {
    it("are in the built-in catalog, dropped where their documents' variables say", () => {
        const { catalog, diagnostics } = loadCatalog({ personalConfig: noPersonal });
        expect(diagnostics.errors).toEqual([]);
        expect(Object.keys(catalog!.recipes).sort()).toEqual(["observability-cluster", "rancher-vm", "registry-vm"]);
        expect(catalog!.recipes["rancher-vm"].value.documents[0]).toMatchObject({ kind: "HarvesterVM", metadata: { name: "rancher" }, spec: { cpu: 4, memory: "8Gi" } });
        expect(recipeDropsOn(catalog!.recipes["observability-cluster"].value)).toEqual(["Harvester"]);
        expect(recipeDropsOn({ documents: [{ apiVersion: "lab.geeko.me/v1alpha1", kind: "Machine", metadata: { name: "m" }, spec: { address: "m.example.com" } }] })).toEqual([]);
    });

    it("add documents that resolve, once the composer has filled them in", () => {
        const { catalog } = loadCatalog({ personalConfig: noPersonal });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-recipes-"));
        // As the composer drops them: on Harvester hv, with the board's Rancher (the rancher-vm's),
        // Rancher's admin password from a secret.
        const filled: Record<string, Record<string, unknown>> = { rancher: { adminPassword: "{{ secrets['rancher-admin'] }}" } };
        const docs = Object.values(catalog!.recipes).flatMap(({ value }) => value.documents.map(d => {
            const spec = renderRecipe(d.spec, vars({ drop: { harvester: "hv" }, rancher: "rancher", os: "leap-16", names: { [d.metadata.name]: d.metadata.name } })) as Record<string, any>;
            if (spec.profiles) spec.profiles = Object.fromEntries(Object.entries(spec.profiles).map(([p, s]) => [p, { ...filled[p], ...(s as object) }]));
            return { ...d, spec };
        }));
        const lab = [
            { apiVersion: "lab.geeko.me/v1alpha1", kind: "Lab", metadata: { name: "recipes" }, spec: {
                domain: "lab.example.com", tls: { acme: "letsencrypt-staging", email: "a@b.cd", cloudflare: "{{ secrets.cf }}" },
                ssh: { publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.key }}" },
                // The observability cluster's StackPacks install with its bootstrap token.
                inputs: { "suse-observability-token": "{{ secrets.observability.token }}" } } },
            { apiVersion: "lab.geeko.me/v1alpha1", kind: "Harvester", metadata: { name: "hv" }, spec: { url: "https://hv.example.com", credentials: "{{ secrets.hv }}" } },
            ...docs,
        ].map(d => stringify(d)).join("---\n");
        fs.writeFileSync(path.join(dir, "lab.yaml"), lab);
        const { diagnostics, lab: resolved } = loadLab({ labFile: path.join(dir, "lab.yaml"), personalConfig: noPersonal });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([]);
        expect(resolved!.downstream.find(d => d.name === "observability")).toMatchObject({ rancher: "rancher", harvester: "hv", stackPacks: ["open-telemetry", "suse-ai"] });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("are checked as lab documents against the catalog, with sample values for their variables", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-catalog-"));
        fs.cpSync(BUILTIN_CATALOG_DIR, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "recipes", "broken.yaml"), `apiVersion: lab.geeko.me/v1alpha1
kind: Recipe
metadata: { name: broken }
spec:
  documents:
    - apiVersion: lab.geeko.me/v1alpha1
      kind: Machine
      metadata: { name: box }
      spec:
        address: \${ drop.somewhere }
        memory: 8Gi
        os: nope
        profiles:
          nope: {}
          harvester-cloud-provider: {}
          hauler: { port: 70000 }
          opentelemetry: { observer: obs }
    - apiVersion: lab.geeko.me/v1alpha1
      kind: DownstreamCluster
      metadata: { name: box }
      spec:
        type: harvester
        harvester: \${ drop.harvester }
        rancher: \${ names.box }
        fleetProfiles: { nope: {} }
        stackPacks: [ suse-ai, nope ]
`);
        const { diagnostics } = loadCatalog({ personalConfig: noPersonal, catalogDir: dir });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([
            expect.stringMatching(/^Recipe\/broken\.spec\.documents\[0\]\.spec: unknown variable \$\{ drop\.somewhere \}; known: drop\.harvester, /),
            'Recipe/broken.spec.documents[0].spec: Unrecognized key: "memory"',
            'Recipe/broken.spec.documents[0].spec: unknown OS "nope"; known: leap-16, rocky-9, sl-micro-6.1, sles-16, ubuntu-24.04',
            expect.stringMatching(/^Recipe\/broken\.spec\.documents\[0\]\.spec\.profiles: unknown profile "nope"; known: ai-demos, ai-factory, /),
            "Recipe/broken.spec.documents[0].spec.profiles.harvester-cloud-provider: only runs on harvester hosts, not a Machine",
            "Recipe/broken.spec.documents[0].spec.profiles.hauler.port: Too big: expected number to be <=65535",
            "Recipe/broken.spec.documents[0].spec.profiles.opentelemetry: doesn't go on a Machine",
            "Recipe/broken.spec.documents[1].metadata.name: box is the name of another of its documents",
            'Recipe/broken.spec.documents[1].spec.fleetProfiles.nope: unknown Fleet profile "nope"',
            'Recipe/broken.spec.documents[1].spec.stackPacks[1]: no StackPack "nope"',
        ]);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
