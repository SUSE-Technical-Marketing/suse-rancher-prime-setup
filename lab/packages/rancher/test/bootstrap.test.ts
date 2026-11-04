import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nameProblem } from "../src/bootstrap";

// Why the lab can't reach Rancher by its URL's name: a Rancher (a /ping answering 200 for its name)
// on 127.0.0.2, and names that don't resolve or lead elsewhere.

const NAME = "rancher.repro.lab.example";
let server: https.Server;
let port = 0;

beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rancher-ping-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${NAME}`,
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    server = https.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
        res.writeHead(req.url === "/ping" && [NAME, "localhost"].includes(req.headers.host ?? "") ? 200 : 404).end("pong");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.2", resolve));
    port = (server.address() as { port: number }).port;
    fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => server?.close());

describe("Rancher's name", () => {
    it("is to blame when it doesn't resolve: for sure once Rancher answers at its host", async () => {
        expect(await nameProblem(`https://${NAME}`, "127.0.0.2", port)).toEqual({
            message: expect.stringMatching(new RegExp(`^${NAME} doesn't resolve: give ${NAME} a DNS record for 127\\.0\\.0\\.2`)), sure: true,
        });
        // Nothing at the host yet (Rancher still starting): it doesn't resolve, but maybe it will.
        expect(await nameProblem(`https://${NAME}`, "127.0.0.3", port)).toMatchObject({ sure: false });
    });

    it("is to blame when it leads elsewhere while Rancher answers at its host", async () => {
        // localhost resolves to 127.0.0.1 (or ::1), not the host 127.0.0.2, where Rancher answers for it.
        expect(await nameProblem("https://localhost", "127.0.0.2", port)).toEqual({
            message: expect.stringMatching(/^localhost resolves to .*, but Rancher answers at its host 127\.0\.0\.2: give localhost a DNS record/), sure: true,
        });
    });

    it("isn't to blame when Rancher doesn't answer at its host: a load balancer or tunnel may serve it", async () => {
        expect(await nameProblem("https://localhost", "127.0.0.3", port)).toBeUndefined();
    });
});
