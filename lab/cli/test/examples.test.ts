import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDiagnostic, loadLab } from "@lab/schema";
import { EXAMPLES_DIR, findExample, listExamples, renderExamples } from "../src/examples";
import { renderPlan } from "../src/plan";

describe("examples helpers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-examples-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "b-two.yaml"), "# Second one.\nkind: Lab\n");
    fs.writeFileSync(path.join(dir, "a-one.yaml"), "# First one.\nkind: Lab\n");
    fs.writeFileSync(path.join(dir, "bare.yaml"), "kind: Lab\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not an example");

    it("lists the yaml files by name, with the first comment line as summary", () => {
        expect(listExamples(dir).map(e => [e.name, e.summary])).toEqual([["a-one", "First one."], ["b-two", "Second one."], ["bare", ""]]);
    });

    it("lists nothing for a missing directory", () => {
        expect(listExamples(path.join(dir, "nope"))).toEqual([]);
    });

    it("finds an example, or names the known ones", () => {
        expect(findExample("a-one", dir).file).toBe(path.join(dir, "a-one.yaml"));
        expect(() => findExample("zzz", dir)).toThrow('no example "zzz"; known: a-one, b-two, bare');
    });

    it("renders names aligned with their summaries", () => {
        expect(renderExamples(listExamples(dir)).split("\n")).toEqual(["a-one  First one.", "b-two  Second one.", "bare   "]);
    });
});

describe("the shipped examples", () => {
    const examples = listExamples();
    let tmp = "";
    let config = "";
    const home = process.env.HOME;
    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-examples-home-"));
        process.env.HOME = tmp;
        fs.mkdirSync(path.join(tmp, ".ssh"));
        fs.writeFileSync(path.join(tmp, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAATEST lab@test\n");
        config = path.join(tmp, "config.yaml");
        fs.writeFileSync(config, [
            "apiVersion: lab.geeko.me/v1alpha1", "kind: PersonalConfig", "metadata: { name: test }", "spec:",
            "  harvesters:", '    my-harvester: { url: "https://harvester.example.com", credentials: { username: admin, password: "env:EXAMPLES_TEST_PASSWORD" } }',
            "  images:", "    sles-16: { url: https://mirror.example.com/sles-16.qcow2 }", "",
        ].join("\n"));
    });
    afterAll(() => {
        process.env.HOME = home;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("exist, each with a summary", () => {
        expect(examples.length).toBeGreaterThanOrEqual(3);
        expect(examples.filter(e => !e.summary).map(e => e.name)).toEqual([]);
    });

    it.each(examples.map(e => e.name))("%s validates and plans", name => {
        const result = loadLab({ labFile: findExample(name).file, personalConfig: config });
        expect(result.diagnostics.errors.map(formatDiagnostic)).toEqual([]);
        expect(renderPlan(result.lab!, new Set())).toContain(result.lab!.name);
    });

    it.each(examples.map(e => e.name))("%s is generic: nothing of the author's lab in it", name => {
        expect(fs.readFileSync(findExample(name).file, "utf8")).not.toMatch(/geeko\.me\/(?!v1alpha1)|vanerp|asgard|10\.29\./);
    });

    it("lives next to the cli", () => {
        expect(path.basename(EXAMPLES_DIR)).toBe("examples");
    });
});
