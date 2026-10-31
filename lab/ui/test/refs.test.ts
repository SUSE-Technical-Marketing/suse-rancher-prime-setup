import { describe, expect, it } from "bun:test";
import { accept, formatPath, openRef, refTree, suggestions } from "../src/refs";

const TREE = refTree(
    { name: "asgard-odin", spec: { domain: "lab.geeko.me", tls: { acme: "letsencrypt", email: "a@b.cd" }, vars: { team: "tmm" } } },
    [
        { path: ["appco"], shape: "credentials" },
        { path: ["cloudflare"], shape: "map", fields: ["token"] },
        { path: ["cloudflare", "token"], shape: "string" },
        { path: ["ssh-key"], shape: "string" },
    ],
);
const at = (text: string) => openRef(text, text.length);
const names = (text: string) => suggestions(TREE, at(text)!).map(s => s.name);
/** Type `text`, take the first suggestion. */
const take = (text: string, after = "") => {
    const ref = openRef(text + after, text.length)!;
    return accept(text + after, text.length, ref, suggestions(TREE, ref)[0]);
};

describe("openRef", () => {
    it("finds the path typed in an open template, and nothing outside one", () => {
        expect(at("x {{")).toEqual({ start: 4, spaced: false, path: [], partial: "" });
        expect(at("{{ lab.tl")).toMatchObject({ path: ["lab"], partial: "tl" });
        expect(at("{{ lab.tls.")).toMatchObject({ path: ["lab", "tls"], partial: "" });
        expect(at("{{ secrets['ssh-key']")).toMatchObject({ path: ["secrets", "ssh-key"], partial: "" });
        expect(at("{{ lab.domain }} and")).toBeUndefined();
        expect(at("{{ lab.domain | upper")).toBeUndefined();
        expect(at("plain")).toBeUndefined();
    });
});

describe("suggestions", () => {
    it("offers lab and secrets first, then what's under them, prefix matches first", () => {
        expect(names("{{ ")).toEqual(["lab", "secrets"]);
        expect(names("{{ lab.")).toEqual(["domain", "name", "tls", "vars"]);
        expect(names("{{ lab.tls.e")).toEqual(["email", "acme"]);
        expect(names("{{ secrets.c")).toEqual(["cloudflare", "appco"]);
        expect(names("{{ secrets.cloudflare.")).toEqual(["token"]);
    });

    it("shows lab values and secret shapes, never secret values", () => {
        const s = suggestions(TREE, at("{{ lab.")!);
        expect(s.find(x => x.name === "domain")!.node.detail).toBe("lab.geeko.me");
        expect(s.find(x => x.name === "name")!.node.detail).toBe("asgard-odin");
        expect(suggestions(TREE, at("{{ secrets.")!).map(x => x.node.detail)).toEqual(["credentials", "fields: token", "string"]);
    });
});

describe("accept", () => {
    it("goes on with a '.' into a map, and closes the template on a value", () => {
        expect(take("{{ la")).toEqual({ text: "{{ lab.", caret: 7, done: false });
        expect(take("{{ lab.do")).toEqual({ text: "{{ lab.domain }}", caret: 16, done: true });
        expect(take("x.{{lab.do")).toEqual({ text: "x.{{ lab.domain }}", caret: 18, done: true });
    });

    it("writes a name with a dash in brackets, and doesn't close a closed template twice", () => {
        expect(take("{{ secrets.ssh")).toEqual({ text: "{{ secrets['ssh-key'] }}", caret: 24, done: true });
        expect(take("{{ lab.do", " }} rest")).toEqual({ text: "{{ lab.domain }} rest", caret: 16, done: true });
        expect(take("{{ lab.do", "main }}")).toEqual({ text: "{{ lab.domain }}", caret: 16, done: true });
    });

    it("takes credentials whole", () => {
        expect(take("{{ secrets.app")).toMatchObject({ text: "{{ secrets.appco }}", done: true });
    });
});

it("formatPath", () => {
    expect(formatPath(["secrets", "cloudflare", "token"])).toBe("secrets.cloudflare.token");
    expect(formatPath(["secrets", "ssh-key"])).toBe("secrets['ssh-key']");
});
