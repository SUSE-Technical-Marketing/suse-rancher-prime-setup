import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsFrom, resolveSecrets, secretEnvName } from "../src/secrets";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-cli-"));
fs.writeFileSync(path.join(dir, "token"), "from-file\n");

describe("resolveSecrets", () => {
    it("resolves literal, env:, file: and cmd: values from the personal config", () => {
        const { values, problems } = resolveSecrets(
            { a: "string", b: "string", c: "string", d: "string", hv: "credentials" },
            { a: "literal", b: "env:MY_VAR", c: "file:token", d: "cmd:echo from-cmd", hv: { username: "admin", password: "env:MY_VAR" } },
            { env: { MY_VAR: "from-env" }, configDir: dir },
        );
        expect(problems).toEqual([]);
        expect(values).toEqual({ a: "literal", b: "from-env", c: "from-file", d: "from-cmd", hv: { username: "admin", password: "from-env" } });
    });

    it("lets LAB_SECRET_* environment variables win, with JSON for credentials", () => {
        const { values } = resolveSecrets(
            { "cloudflare-token": "string", "hv-north": "credentials" },
            { "cloudflare-token": "from-config" },
            { env: { LAB_SECRET_CLOUDFLARE_TOKEN: "from-env", LAB_SECRET_HV_NORTH: '{"username":"u","password":"p"}' }, configDir: dir },
        );
        expect(values).toEqual({ "cloudflare-token": "from-env", "hv-north": { username: "u", password: "p" } });
    });

    it("explains missing and malformed secrets", () => {
        const { problems } = resolveSecrets(
            { missing: "string", shape: "credentials", unset: "string", broken: "string" },
            { shape: "just-a-string", unset: "env:NOPE", broken: "cmd:exit 3" },
            { env: {}, configDir: dir },
        );
        expect(problems).toEqual([
            'secret "broken": command failed: exit 3',
            'secret "missing" is not set: add it under secrets: in the personal config, or set LAB_SECRET_MISSING',
            'secret "shape": secret "shape" must have a username and a password',
            'secret "unset": environment variable NOPE is not set',
        ]);
    });

    it("checks a map secret's fields and passes on only the ones the lab uses", () => {
        const { values, problems } = resolveSecrets(
            { aws: { fields: ["accessKey", "secretKey"] }, half: { fields: ["accessKey", "secretKey"] }, json: { fields: ["token"] } },
            { aws: { accessKey: "AK", secretKey: "env:SK", region: "eu-west-1" }, half: { accessKey: "AK" } },
            { env: { SK: "from-env", LAB_SECRET_JSON: '{"token":"t","other":"o"}' }, configDir: dir },
        );
        expect(values).toEqual({ aws: { accessKey: "AK", secretKey: "from-env" }, json: { token: "t" } });
        expect(problems).toEqual(['secret "half": secret "half" must be a map with accessKey, secretKey (it has accessKey)']);
    });

    it("leaves secrets and fields the lab doesn't use alone, whatever they hold", () => {
        const { values, problems } = resolveSecrets(
            { cf: { fields: ["token"] }, list: "string", deep: { fields: ["key"] } },
            {
                cf: { token: "t", tunnel: { account: "a", id: 1 }, never: "cmd:exit 9" },
                list: ["a", "b"],
                deep: { key: { nested: "x" } },
                unused: { anything: [1, { goes: true }] },
            },
            { env: {}, configDir: dir },
        );
        expect(values).toEqual({ cf: { token: "t" } });
        expect(problems).toEqual([
            'secret "deep": secret "deep": field key must be a string, and it\'s a map',
            'secret "list": secret "list" must be a string, and it\'s a list',
        ]);
    });
});

describe("credentialsFrom", () => {
    it("handles a whole-credentials secret and a password secret", () => {
        const secrets = { hv: { username: "admin", password: "x" }, pw: "y" };
        expect(credentialsFrom("{{ secrets.hv }}", secrets)).toEqual({ username: "admin", password: "x" });
        expect(credentialsFrom({ username: "root", password: "{{ secrets.pw }}" }, secrets)).toEqual({ username: "root", password: "y" });
        expect(credentialsFrom({ username: "root", password: "inline" }, secrets)).toEqual({ username: "root", password: "inline" });
    });
});

it("names env variables predictably", () => {
    expect(secretEnvName("hv-north")).toBe("LAB_SECRET_HV_NORTH");
    expect(secretEnvName("scc.regcode")).toBe("LAB_SECRET_SCC_REGCODE");
});
