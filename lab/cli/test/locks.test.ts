import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stateLocks } from "../src/workspace";

// A lab's state locks in the file backend: a running command's, and one a stopped command left.

describe("state locks", () => {
    it("tells a running command's lock from a stale one, and one from another machine", () => {
        const state = fs.mkdtempSync(path.join(os.tmpdir(), "lab-state-"));
        const dir = path.join(state, ".pulumi", "locks", "organization", "lab", "demo");
        fs.mkdirSync(dir, { recursive: true });
        const lock = (name: string, pid: number, hostname = os.hostname()) =>
            fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ pid, username: "me", hostname, timestamp: "2026-11-03T22:00:00Z" }));
        lock("running", process.pid);
        lock("stale", 2 ** 22 + 7);
        lock("elsewhere", 1234, "another-host");
        fs.writeFileSync(path.join(dir, "running.json.attrs"), "{}");
        const locks = Object.fromEntries(stateLocks("demo", { backendUrl: `file://${state}` }).map(l => [path.basename(l.file, ".json"), l]));
        expect(Object.keys(locks).sort()).toEqual(["elsewhere", "running", "stale"]);
        expect(locks.running).toMatchObject({ user: "me", pid: process.pid, running: true });
        expect(locks.stale.running).toBe(false);
        expect(locks.elsewhere.running).toBeUndefined();
        // No lock, or a backend that isn't a directory: nothing to say.
        expect(stateLocks("other", { backendUrl: `file://${state}` })).toEqual([]);
        expect(stateLocks("demo", { backendUrl: "s3://bucket" })).toEqual([]);
        fs.rmSync(state, { recursive: true, force: true });
    });
});
