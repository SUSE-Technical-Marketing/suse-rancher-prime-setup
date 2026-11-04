import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ResolvedCatalog, ResolvedLab } from "@lab/schema";
import { buildCatalogStackPacks, buildStackPack, stackPackProblems } from "../src/stackpacks";

// StackPacks built from source before `up` (`lab stackpacks`): a .sts from a tag's archive, as SUSE's
// packaging script makes it, pinned by its sha256; and `up` refusing a lab whose .sts isn't built.

const text = (s: string) => new TextEncoder().encode(s);
/** A tag's source zip as GitHub serves it (one top directory): the StackPack's directory, and what its .sts leaves out. */
const source = (version: string) => zipSync({
    [`ext-${version}/README.md`]: text("the repo"),
    [`ext-${version}/stackpack/suse-ai/stackpack.yaml`]: text(`name: suse-ai\nversion: ${version}\n`),
    [`ext-${version}/stackpack/suse-ai/README.md`]: text("the StackPack"),
    [`ext-${version}/stackpack/suse-ai/settings/menu.sty`]: text("menu"),
    [`ext-${version}/stackpack/suse-ai/includes/a/b.sty`]: text("b"),
    [`ext-${version}/stackpack/suse-ai/resources/overview.md`]: text("overview"),
    [`ext-${version}/stackpack/suse-ai/icons/logo.svg`]: text("<svg/>"),
    [`ext-${version}/stackpack/suse-ai/Taskfile.yaml`]: text("not in a .sts"),
    [`ext-${version}/tests/x.py`]: text("nor this"),
});
const shaOf = (version: string) => buildStackPack(source(version), "stackpack/suse-ai").sha256;

/** A catalog with the suse-ai StackPack from source, pinned to a sha256, and one from the instance's catalog. */
const catalog = (sha256: string) => ({
    components: {
        "suse-ai": { value: { kind: "StackPack", version: "3.0.0", archive: "https://example.com/v{version}.zip", path: "stackpack/suse-ai", sha256, unlocked: "overwrite" }, source: "test" },
        "open-telemetry": { value: { kind: "StackPack", unlocked: "fail" }, source: "test" },
    },
}) as unknown as ResolvedCatalog;

/** A fetch serving the archive of the version in its URL, counting downloads. */
const fakeFetch = () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
        urls.push(url);
        return new Response(Buffer.from(source(/v(.+)\.zip$/.exec(url)![1])));
    }) as unknown as typeof fetch;
    return { fetch: f, urls };
};

describe("a .sts built from a source archive", () => {
    it("holds the StackPack's directory as its packaging script takes it, the same bytes every time", () => {
        const a = buildStackPack(source("3.0.0"), "stackpack/suse-ai");
        expect(a.version).toBe("3.0.0");
        const files = unzipSync(a.sts);
        expect(Object.keys(files)).toEqual(["README.md", "icons/logo.svg", "includes/a/b.sty", "resources/overview.md", "settings/menu.sty", "stackpack.yaml"]);
        expect(new TextDecoder().decode(files["README.md"])).toBe("the StackPack");
        expect(buildStackPack(source("3.0.0"), "/stackpack/suse-ai/").sha256).toBe(a.sha256);
        expect(() => buildStackPack(source("3.0.0"), "stackpack/other")).toThrow(/no ext-3\.0\.0\/stackpack\/other\/stackpack\.yaml/);
    });
});

describe("lab stackpacks", () => {
    const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "stackpacks-"));

    it("builds the catalog's StackPacks from source once, and only the pinned one", async () => {
        const out = dir();
        const fileOf = (name: string, version: string) => path.join(out, `${name}-${version}.sts`);
        const f = fakeFetch();
        const built = await buildCatalogStackPacks(catalog(shaOf("3.0.0")), { fetch: f.fetch, fileOf });
        expect(built).toEqual([expect.stringMatching(/^suse-ai 3\.0\.0: built \(.*suse-ai-3\.0\.0\.sts, sha256 [0-9a-f]{64}\)$/)]);
        expect(f.urls).toEqual(["https://example.com/v3.0.0.zip"]);
        expect(createHash("sha256").update(fs.readFileSync(fileOf("suse-ai", "3.0.0"))).digest("hex")).toBe(shaOf("3.0.0"));
        // Again: there already, nothing downloaded; --force builds it again.
        expect(await buildCatalogStackPacks(catalog(shaOf("3.0.0")), { fetch: f.fetch, fileOf })).toEqual([expect.stringMatching(/^suse-ai 3\.0\.0: built already/)]);
        expect(f.urls).toHaveLength(1);
        await buildCatalogStackPacks(catalog(shaOf("3.0.0")), { fetch: f.fetch, fileOf, force: true });
        expect(f.urls).toHaveLength(2);
    });

    it("refuses a source whose .sts isn't the pinned one, writing nothing", async () => {
        const out = dir();
        const fileOf = (name: string, version: string) => path.join(out, `${name}-${version}.sts`);
        await expect(buildCatalogStackPacks(catalog("0".repeat(64)), { fetch: fakeFetch().fetch, fileOf }))
            .rejects.toThrow(/has sha256 [0-9a-f]{64}, not the catalog's 0{64}: has its source changed\?/);
        expect(fs.readdirSync(out)).toEqual([]);
    });
});

describe("up's check", () => {
    it("refuses a lab whose StackPacks from source aren't built, or aren't the pinned ones", () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), "stackpacks-"));
        const file = path.join(out, "suse-ai-3.0.0.sts");
        const lab = { stackPacks: [
            { observer: "obs", name: "suse-ai", file, stackPack: { kind: "StackPack", version: "3.0.0", sha256: shaOf("3.0.0") } },
            { observer: "obs", name: "open-telemetry", stackPack: { kind: "StackPack", unlocked: "fail" } },
        ] } as unknown as ResolvedLab;
        expect(stackPackProblems(lab)).toEqual([`StackPack suse-ai 3.0.0 (on obs) isn't built: run "lab stackpacks" (mise run stackpacks)`]);
        fs.writeFileSync(file, "something else");
        expect(stackPackProblems(lab)).toEqual([expect.stringMatching(/^StackPack suse-ai 3\.0\.0 \(on obs\): .* has sha256 [0-9a-f]{64}, not the catalog's [0-9a-f]{64}: run "lab stackpacks --force"$/)]);
        fs.writeFileSync(file, buildStackPack(source("3.0.0"), "stackpack/suse-ai").sts);
        expect(stackPackProblems(lab)).toEqual([]);
    });
});
