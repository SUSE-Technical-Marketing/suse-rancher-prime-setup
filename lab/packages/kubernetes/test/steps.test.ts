import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stepScript } from "../src/host";

// A machine's setup, run as cloud-init runs a VM's runcmd: an OS profile's multi-line blocks and
// `|| true` must work, and a failure must say which step.
describe("stepScript", () => {
    const run = (commands: string[]) => execFileSync("sh", ["-s"], { input: stepScript(commands), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });

    it("runs a multi-line block followed by more commands", () => {
        // A YAML `|` block ends in a newline, which `&&` couldn't follow.
        expect(run(["if true; then\n  echo block\nfi\n", "echo after"])).toBe("block\nafter\n");
    });

    it("leaves failures inside a command to the command", () => {
        // The helm-controller watch stops a unit that may not exist yet, then starts it.
        expect(run(["{ false; } 2>/dev/null; echo started", "echo next"])).toBe("started\nnext\n");
    });

    it("stops at the first command that fails, but not at one that allows it, and says which", () => {
        expect(run(["false || true", "echo still"])).toBe("still\n");
        const failed = spawnSync("sh", ["-s"], { input: stepScript(["echo one", "(exit 5)", "echo never"]), encoding: "utf8" });
        expect(failed.status).toBe(5);
        expect(failed.stdout).toBe("one\n");
        expect(failed.stderr).toContain("lab: step 2/3 failed (exit 5)");
    });
});
