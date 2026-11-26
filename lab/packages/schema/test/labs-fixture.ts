import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { parseAllDocuments } from "yaml";

// The example labs in labs/ need a personal config for what is not theirs to say: where each
// Harvester and AWS site is, and the images of OS profiles that have no public one. The fixture
// makes one from the lab files themselves (every Harvester and AWS site they declare), and a fake
// home with the ssh public key they reference. Call `labsFixture()` at the top of a test file.

export const LABS_DIR = path.resolve(__dirname, "..", "..", "..", "labs");
export const labFiles = fs.readdirSync(LABS_DIR).filter(f => f.endsWith(".yaml")).sort();

/** The names of the documents of a kind, across every lab file. */
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

export function labsFixture(): { personalConfig: () => string; labPath: (file: string) => string } {
    let tmp = "";
    let config = "";
    const originalHome = process.env.HOME;
    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-labs-"));
        process.env.HOME = tmp;
        fs.mkdirSync(path.join(tmp, ".ssh"));
        fs.writeFileSync(path.join(tmp, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAATEST lab@test\n");
        const harvesters = namesOf("Harvester").map(n => `    ${n}: { url: "https://${n}.lab.example.com", credentials: { username: admin, password: "env:LABS_TEST_PASSWORD" } }`);
        const awsSites = namesOf("AwsSite").map(n => `    ${n}: { region: eu-west-1, credentials: { accessKey: AKIATEST, secretKey: "env:LABS_TEST_PASSWORD" } }`);
        config = path.join(tmp, "config.yaml");
        fs.writeFileSync(config, [
            "apiVersion: lab.geeko.me/v1alpha1", "kind: PersonalConfig", "metadata: { name: test }", "spec:",
            ...(harvesters.length > 0 ? ["  harvesters:", ...harvesters] : []),
            ...(awsSites.length > 0 ? ["  awsSites:", ...awsSites] : []),
            // OS profiles without a public image: the personal config says where the user's own are.
            "  images:", "    sles-16: { url: https://mirror.example.com/sles-16.qcow2 }", "    sl-micro-6.1: { url: https://mirror.example.com/sl-micro-6.1.qcow2 }", "",
        ].join("\n"));
    });
    afterAll(() => {
        process.env.HOME = originalHome;
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    return { personalConfig: () => config, labPath: file => path.join(LABS_DIR, file) };
}
