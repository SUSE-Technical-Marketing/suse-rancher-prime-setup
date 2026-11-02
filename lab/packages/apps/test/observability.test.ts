import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registrationProvider } from "../src/observability";

// The registration against a stub of SUSE Observability's API: the calls its CLI makes, in order.

const ADMIN = "admin-token";
let server: http.Server;
let url = "";
let calls: string[] = [];
let tokens: { id: number; name: string; roles: string[] }[] = [];
let subjects: string[] = [];
let instances: { id: number; config: Record<string, string> }[] = [];
let virtualization: { id: number; config: Record<string, string> }[] = [];
let unauthorized = false;
let expired = false;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
            const send = (status: number, json?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(json === undefined ? "" : JSON.stringify(json)); };
            if (req.headers["x-api-key"] !== ADMIN || unauthorized) return send(401, { message: "Token has expired" });
            if (expired) return send(402, { errors: [{ message: "Your SUBSCRIPTION is expired.", errorCode: 9999 }] });
            const path = req.url!.replace(/^\/api/, "");
            calls.push(`${req.method} ${path}${body ? ` ${body}` : ""}`);
            if (req.method === "GET" && path === "/security/tokens") return send(200, tokens);
            if (req.method === "PUT" && path.startsWith("/security/subjects/")) { subjects.push(decodeURIComponent(path.split("/").pop()!)); return send(201); }
            if (req.method === "POST" && path.startsWith("/security/permissions/")) return send(204);
            if (req.method === "POST" && path === "/security/tokens") {
                const { name, roles } = JSON.parse(body);
                tokens.push({ id: tokens.length + 10, name, roles });
                return send(200, { name, token: `token-of-${name}` });
            }
            if (req.method === "DELETE" && path.startsWith("/security/tokens/")) { tokens = tokens.filter(t => t.id !== Number(path.split("/").pop())); return send(204); }
            if (req.method === "GET" && path === "/stackpack") return send(200, [{ name: "other", configurations: [] }, { name: "kubernetes-v2", configurations: instances }, { name: "suse-virtualization", configurations: virtualization }]);
            if (req.method === "POST" && path.startsWith("/stackpack/suse-virtualization/provision")) {
                virtualization.push({ id: 900, config: JSON.parse(body) });
                return send(200, { id: 900, status: "INSTALLED", config: JSON.parse(body) });
            }
            if (req.method === "POST" && path.startsWith("/stackpack/kubernetes-v2/provision")) {
                const id = 100 + instances.length;
                instances.push({ id, config: JSON.parse(body) });
                return send(200, { id, status: "INSTALLED", stackPackVersion: "2.0", config: JSON.parse(body) });
            }
            if (req.method === "POST" && path.startsWith("/stackpack/kubernetes-v2/deprovision/")) { instances = instances.filter(i => i.id !== Number(path.split("/").pop())); return send(200); }
            if (req.method === "DELETE" && path.startsWith("/security/subjects/")) { subjects = subjects.filter(s => s !== decodeURIComponent(path.split("/").pop()!)); return send(204); }
            send(404);
        });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { calls = []; tokens = []; subjects = []; instances = []; virtualization = []; unauthorized = false; expired = false; });

const inputs = () => ({ url, adminToken: ADMIN, subject: "agent-apps", clusterName: "apps", insecure: false, timeoutSeconds: 5 });

describe("ObservabilityRegistration", () => {
    it("creates the subject, grants update-metrics, makes the agent's service token, and installs its cluster's kubernetes-v2 StackPack", async () => {
        const { outs } = await registrationProvider.create!(inputs());
        expect(outs).toMatchObject({ token: "token-of-agent-apps", stackPackInstance: 100 });
        expect(calls).toEqual([
            "GET /security/tokens",
            "PUT /security/subjects/agent-apps {}",
            'POST /security/permissions/agent-apps {"permission":"update-metrics","resourceName":"system"}',
            "GET /security/tokens",
            'POST /security/tokens {"name":"agent-apps","roles":["agent-apps"]}',
            "GET /stackpack",
            'POST /stackpack/kubernetes-v2/provision?unlocked=fail {"kubernetes_cluster_name":"apps"}',
        ]);
    });

    it("installs the one suse-virtualization instance for a Harvester, without parameters, and reuses it", async () => {
        const harvester = { ...inputs(), subject: "agent-asgard", clusterName: "asgard", virtualization: true };
        const { outs } = await registrationProvider.create!(harvester);
        expect(outs).toMatchObject({ stackPackInstance: 100, virtualizationInstance: 900 });
        expect(calls).toContain("POST /stackpack/suse-virtualization/provision?unlocked=fail {}");
        calls = [];
        const other = await registrationProvider.create!({ ...harvester, subject: "agent-other", clusterName: "other" });
        expect(other.outs.virtualizationInstance).toBe(900);
        expect(calls.some(c => c.includes("suse-virtualization/provision"))).toBe(false);
        // Removing one Harvester's agent leaves the shared instance.
        await registrationProvider.delete!("id", outs);
        expect(virtualization).toHaveLength(1);
    });

    it("adds suse-virtualization in place to a Harvester's registration from before", async () => {
        const { outs } = await registrationProvider.create!(inputs());
        expect(await registrationProvider.diff!("id", outs, { ...inputs(), virtualization: true })).toMatchObject({ changes: true, replaces: [] });
        expect((await registrationProvider.update!("id", outs, { ...inputs(), virtualization: true })).outs).toMatchObject({ token: "token-of-agent-apps", virtualizationInstance: 900 });
    });

    it("reuses the cluster's StackPack instance when it has one", async () => {
        instances = [{ id: 7, config: { kubernetes_cluster_name: "apps" } }, { id: 8, config: { kubernetes_cluster_name: "other" } }];
        expect((await registrationProvider.create!(inputs())).outs.stackPackInstance).toBe(7);
        expect(calls.some(c => c.includes("/provision"))).toBe(false);
    });

    it("gives a registration from before StackPacks one in place, keeping its token", async () => {
        const old = { ...inputs(), clusterName: undefined as unknown as string, token: "old-token" };
        expect(await registrationProvider.diff!("id", old, inputs())).toMatchObject({ changes: true, replaces: [] });
        expect((await registrationProvider.update!("id", old, inputs())).outs).toMatchObject({ token: "old-token", stackPackInstance: 100 });
        expect(instances).toEqual([{ id: 100, config: { kubernetes_cluster_name: "apps" } }]);
    });

    it("replaces a token left from an earlier attempt: its value is only shown when it's made", async () => {
        tokens = [{ id: 3, name: "agent-apps", roles: ["agent-apps"] }, { id: 4, name: "agent-other", roles: [] }];
        await registrationProvider.create!(inputs());
        expect(calls).toContain("DELETE /security/tokens/3");
        expect(tokens.map(t => t.name).sort()).toEqual(["agent-apps", "agent-other"]);
    });

    it("waits while the admin token is rejected (Fleet rolling it out), then registers", async () => {
        unauthorized = true;
        setTimeout(() => (unauthorized = false), 1500);
        const { outs } = await registrationProvider.create!(inputs());
        expect(outs.token).toBe("token-of-agent-apps");
    });

    it("waits while the license is refused (Fleet redeploying with a new one), and fails if it stays so", async () => {
        expired = true;
        setTimeout(() => (expired = false), 1500);
        expect((await registrationProvider.create!(inputs())).outs.token).toBe("token-of-agent-apps");
        expired = true;
        await expect(registrationProvider.create!(inputs())).rejects.toThrow(/keeps refusing its API \(HTTP 402: Your SUBSCRIPTION is expired\.\): check its license/);
    }, 15000);

    it("fails when the admin token keeps being rejected", async () => {
        unauthorized = true;
        await expect(registrationProvider.create!(inputs())).rejects.toThrow(/keeps rejecting the admin token .*HTTP 401: Token has expired/);
    });

    it("deletes the agent's tokens and subject, and skips an instance that's gone", async () => {
        const { outs } = await registrationProvider.create!(inputs());
        calls = [];
        await registrationProvider.delete!("id", outs);
        expect(calls).toEqual(["GET /security/tokens", "GET /stackpack", "POST /stackpack/kubernetes-v2/deprovision/100", "GET /security/tokens", "DELETE /security/tokens/10", "DELETE /security/subjects/agent-apps"]);
        expect(instances).toEqual([]);
        expect(tokens).toEqual([]);
        expect(subjects).toEqual([]);
        await expect(registrationProvider.delete!("id", { ...outs, url: "http://127.0.0.1:9" })).resolves.toBeUndefined();
    });

    it("is replaced for another instance or name, updated in place for another admin token", async () => {
        const { outs } = await registrationProvider.create!(inputs());
        expect(await registrationProvider.diff!("id", outs, { ...inputs(), subject: "agent-x" })).toMatchObject({ changes: true, replaces: ["subject"] });
        expect(await registrationProvider.diff!("id", outs, { ...inputs(), adminToken: "new" })).toMatchObject({ changes: true, replaces: [] });
        expect(await registrationProvider.update!("id", outs, { ...inputs(), adminToken: "new" })).toMatchObject({ outs: { token: "token-of-agent-apps", adminToken: "new" } });
    });
});
