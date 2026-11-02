import { afterEach, describe, expect, it } from "bun:test";
import { api } from "../src/api";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });
const answer = (body: string, status: number) => { globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch; };

describe("api", () => {
    it("says the server didn't answer when what comes back isn't JSON, with what did come back", async () => {
        answer("<html><body>Error occurred while trying to proxy: 127.0.0.1:4173/api/catalog</body></html>", 500);
        await expect(api.catalog()).rejects.toThrow(/the lab UI's server didn't answer GET \/api\/catalog \(HTTP 500: Error occurred while trying to proxy: 127\.0\.0\.1:4173\/api\/catalog\)\. Is it running\?/);
    });

    it("passes the server's own error on", async () => {
        answer(JSON.stringify({ error: "spec.secrets: broken" }), 500);
        await expect(api.catalog()).rejects.toThrow("spec.secrets: broken");
    });
});
