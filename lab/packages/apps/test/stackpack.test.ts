import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stackPackProvider } from "../src/stackpack";

// StackPacks against a stub of SUSE Observability's API: the calls `sts stackpack upload / install /
// upgrade` make, in order. A StackPack from source is a .sts `lab stackpacks` built: here, a file.

const ADMIN = "admin-token";
/** A built .sts of a version, as a file: what `lab stackpacks` leaves for `up`. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackpacks-"));
const sts = (version: string) => {
    const file = path.join(dir, `suse-ai-${version}.sts`);
    fs.writeFileSync(file, `a .sts of suse-ai ${version}`);
    return { file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
};

let server: http.Server;
let url = "";
let calls: string[] = [];
let uploaded: { version: string; file: string }[] = [];
let instances: { name: string; id: number; status: string; stackPackVersion: string; polled: number }[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            const send = (status: number, json?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(json === undefined ? "" : JSON.stringify(json)); };
            if (req.headers["x-api-key"] !== ADMIN) return send(401);
            const path = req.url!.replace(/^\/api/, "");
            calls.push(`${req.method} ${path}`);
            if (req.method === "GET" && path === "/security/tokens") return send(200, []);
            if (req.method === "GET" && path === "/stackpack") {
                // A new instance is provisioning on the first look, installed on the next.
                for (const i of instances) if (i.polled++ > 0 && i.status === "PROVISIONING") i.status = "INSTALLED";
                return send(200, [
                    { name: "open-telemetry", version: "1.4.0", configurations: instances.filter(i => i.name === "open-telemetry").map(({ polled: _, name: __, ...c }) => c) },
                    { name: "suse-ai", version: uploaded.at(-1)?.version ?? "2.2.0", configurations: instances.filter(i => i.name === "suse-ai").map(({ polled: _, name: __, ...c }) => c) },
                ]);
            }
            if (req.method === "GET" && path === "/stackpack/suse-ai/versions") return send(200, uploaded.map(u => ({ version: u.version, isDev: false, isInUse: false })));
            if (req.method === "POST" && path === "/stackpack") {
                // multipart/form-data: the form field stackPack, its file a .sts.
                const head = body.subarray(0, 300).toString();
                expect(req.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
                expect(head).toContain('name="stackPack"; filename="suse-ai-');
                const start = body.indexOf("\r\n\r\n") + 4, end = body.lastIndexOf("\r\n--");
                const file = body.subarray(start, end).toString();
                const version = /^a \.sts of suse-ai (.+)$/.exec(file)![1];
                uploaded.push({ version, file });
                return send(200, { name: "suse-ai", version });
            }
            const provision = /^\/stackpack\/(suse-ai|open-telemetry)\/provision\?(.*)$/.exec(path);
            if (req.method === "POST" && provision) {
                const q = new URLSearchParams(provision[2]);
                const id = 300 + instances.length;
                instances.push({ name: provision[1], id, status: "PROVISIONING", stackPackVersion: q.get("version") ?? "1.4.0", polled: 0 });
                return send(200, { id, status: "PROVISIONING" });
            }
            if (req.method === "POST" && path.startsWith("/stackpack/suse-ai/upgrade?")) {
                for (const i of instances) { i.stackPackVersion = uploaded.at(-1)!.version; i.status = "PROVISIONING"; i.polled = 0; }
                return send(200);
            }
            if (req.method === "POST" && path.startsWith("/stackpack/suse-ai/deprovision/")) { instances = instances.filter(i => i.id !== Number(path.split("/").pop())); return send(200); }
            send(404);
        });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true }); });
beforeEach(() => { calls = []; uploaded = []; instances = []; });

const suseAi = (version = "3.0.0") => ({
    url, adminToken: ADMIN, name: "suse-ai", version, ...sts(version), unlocked: "overwrite" as const, insecure: false, timeoutSeconds: 10,
});

// Provisioning is polled every 3 seconds.
describe("a StackPack on an instance", { timeout: 20000 }, () => {
    it("is uploaded from its file, installed at its version and waited on", async () => {
        const { id, outs } = await stackPackProvider.create!(suseAi());
        expect(id).toBe(`${url}/suse-ai`);
        expect(outs).toMatchObject({ instance: 300, installedVersion: "3.0.0" });
        expect(uploaded).toEqual([{ version: "3.0.0", file: "a .sts of suse-ai 3.0.0" }]);
        expect(calls).toContain("POST /stackpack/suse-ai/provision?unlocked=overwrite&version=3.0.0");
        expect(calls.indexOf("POST /stackpack")).toBeLessThan(calls.indexOf("POST /stackpack/suse-ai/provision?unlocked=overwrite&version=3.0.0"));
    });

    it("isn't uploaded again when the instance has that version (uploads are immutable)", async () => {
        uploaded.push({ version: "3.0.0", file: "" });
        await stackPackProvider.create!(suseAi());
        expect(calls).not.toContain("POST /stackpack");
        expect(uploaded).toHaveLength(1);
    });

    it("refuses a file that isn't the pinned .sts, or isn't there, before uploading anything", async () => {
        await expect(stackPackProvider.create!({ ...suseAi(), sha256: "0".repeat(64) })).rejects.toThrow(/has sha256 [0-9a-f]{64}, not 0{64}: run "lab stackpacks --force"/);
        await expect(stackPackProvider.create!({ ...suseAi(), file: path.join(dir, "nope.sts") })).rejects.toThrow(/nope\.sts isn't there: run "lab stackpacks"/);
        expect(calls.filter(c => c.startsWith("POST"))).toEqual([]);
    });

    it("from the instance's own catalog, is installed without an upload, at its latest version", async () => {
        const { outs } = await stackPackProvider.create!({ url, adminToken: ADMIN, name: "open-telemetry", unlocked: "fail", insecure: false, timeoutSeconds: 10 });
        expect(outs).toMatchObject({ installedVersion: "1.4.0" });
        expect(calls).toContain("POST /stackpack/open-telemetry/provision?unlocked=fail");
        expect(calls).not.toContain("POST /stackpack");
    });

    it("is upgraded in place to a new version", async () => {
        const { outs } = await stackPackProvider.create!(suseAi("3.0.0"));
        const diff = await stackPackProvider.diff!("", outs, suseAi("3.1.0"));
        expect(diff).toMatchObject({ changes: true, replaces: [] });
        const updated = await stackPackProvider.update!("", outs, suseAi("3.1.0"));
        expect(updated.outs).toMatchObject({ instance: 300, installedVersion: "3.1.0" });
        expect(calls).toContain("POST /stackpack/suse-ai/upgrade?unlocked=overwrite");
        expect(uploaded.map(u => u.version)).toEqual(["3.0.0", "3.1.0"]);
    });

    it("is uninstalled when deleted, and skipped when the instance is gone", async () => {
        const { outs } = await stackPackProvider.create!(suseAi());
        await stackPackProvider.delete!("", outs);
        expect(instances).toEqual([]);
        expect(calls).toContain("POST /stackpack/suse-ai/deprovision/300");
        await expect(stackPackProvider.delete!("", { ...outs, url: "http://127.0.0.1:1" })).resolves.toBeUndefined();
    });
});
