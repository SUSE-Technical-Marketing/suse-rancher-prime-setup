import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { formatDiagnostic, loadLab } from "@lab/schema";
import { renderPlan } from "../src/plan";

// `lab plan` of every example lab, as a snapshot. A refactor of how hosts, sites and backends are
// modelled must not change what a lab says it will build: if this snapshot changes, so did the plan.
// (Update it deliberately with `vitest -u` when a plan is meant to change.)

const LABS_DIR = path.resolve(__dirname, "..", "..", "labs");
const labFiles = fs.readdirSync(LABS_DIR).filter(f => f.endsWith(".yaml")).sort();

let tmp: string;
let personalConfig: string;
const originalHome = process.env.HOME;

function namesOf(kind: string): string[] {
    const names = new Set<string>();
    for (const file of labFiles) {
        for (const doc of parseAllDocuments(fs.readFileSync(path.join(LABS_DIR, file), "utf8"))) {
            const json = doc.toJSON();
            if (json?.kind === kind && json.metadata?.name) names.add(json.metadata.name);
        }
    }
    return [...names].sort();
}

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-plan-"));
    process.env.HOME = tmp;
    fs.mkdirSync(path.join(tmp, ".ssh"));
    fs.writeFileSync(path.join(tmp, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAATEST lab@test\n");
    const harvesters = namesOf("Harvester").map(n => `    ${n}: { url: "https://${n}.lab.example.com", credentials: { username: admin, password: "env:LABS_TEST_PASSWORD" } }`);
    const awsSites = namesOf("AwsSite").map(n => `    ${n}: { region: eu-west-1, credentials: { accessKey: AKIATEST, secretKey: "env:LABS_TEST_PASSWORD" } }`);
    personalConfig = path.join(tmp, "config.yaml");
    fs.writeFileSync(personalConfig, [
        "apiVersion: lab.geeko.me/v1alpha1", "kind: PersonalConfig", "metadata: { name: test }", "spec:",
        ...(harvesters.length > 0 ? ["  harvesters:", ...harvesters] : []),
        ...(awsSites.length > 0 ? ["  awsSites:", ...awsSites] : []),
        "  images:", "    sles-16: { url: https://mirror.example.com/sles-16.qcow2 }", "    sl-micro-6.1: { url: https://mirror.example.com/sl-micro-6.1.qcow2 }", "",
    ].join("\n"));
});

afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("lab plan of the example labs", () => {
    it.each(labFiles)("%s", file => {
        const { lab, diagnostics } = loadLab({ labFile: path.join(LABS_DIR, file), personalConfig });
        expect(diagnostics.errors.map(formatDiagnostic)).toEqual([]);
        // Paths in the plan (a local image file) would differ per machine: the test config has none.
        expect(renderPlan(lab!, new Set())).toMatchSnapshot();
    });
});
