import { describe, expect, it } from "vitest";
import { poll } from "../src/poll";

describe("poll", () => {
    it("tries until check gives a value", async () => {
        let n = 0;
        const value = await poll(async seen => (++n < 3 ? (seen(`try ${n}`), undefined) : "done"), { timeoutSeconds: 5, everyMs: 1, failure: last => last });
        expect(value).toBe("done");
        expect(n).toBe(3);
    });

    it("fails with what it saw last once time is up", async () => {
        let n = 0;
        await expect(poll(async seen => { seen(`try ${++n}`); return undefined; }, { timeoutSeconds: 0.02, everyMs: 5, failure: last => `gave up: ${last}` }))
            .rejects.toThrow(/^gave up: try \d+$/);
    });

    it("stops at once when check throws", async () => {
        let n = 0;
        await expect(poll(async () => { n++; throw new Error("rejected"); }, { timeoutSeconds: 5, everyMs: 1, failure: () => "time" })).rejects.toThrow("rejected");
        expect(n).toBe(1);
    });
});
