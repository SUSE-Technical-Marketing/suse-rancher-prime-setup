import { stringify } from "yaml";
import { z } from "zod";
import { osName } from "./primitives";

// HaulManifest documents (DESIGN.md §9.4): what a Hauler store holds, by name, for the `hauler`
// and `hauler-chart` profiles' `manifests` settings. Written in the lab's own terms and rendered
// into Hauler's content documents (`content.hauler.cattle.io/v1` Images, Charts and Files).

/** A HaulManifest's name: a lowercase name that may have dots (`rancher-2.15`). */
export const haulManifestName = osName;

export const HaulManifestInput = z.strictObject({
    /** Images to pull: `name` as a reference (`rancher/rancher:v2.15.2`), optionally one platform. */
    images: z.array(z.strictObject({
        name: z.string().min(1),
        platform: z.string().regex(/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/, "must be a platform like linux/amd64").optional(),
    })).optional(),
    /** Helm charts; `addImages` pulls the images they reference too, `addDependencies` their dependencies. */
    charts: z.array(z.strictObject({
        name: z.string().min(1),
        repoURL: z.string().min(1),
        version: z.string().min(1),
        addImages: z.boolean().optional(),
        addDependencies: z.boolean().optional(),
    })).optional(),
    /** Files (a path or URL), served by Hauler's fileserver; `name` renames one. */
    files: z.array(z.strictObject({ path: z.string().min(1), name: z.string().min(1).optional() })).optional(),
});
export type HaulManifestInput = z.infer<typeof HaulManifestInput>;

const CONTENT = "content.hauler.cattle.io/v1";

/** A HaulManifest as Hauler reads it: one content document per kind it has, for `hauler store sync`. */
export function renderHaulManifest(name: string, m: HaulManifestInput): string {
    const docs: Record<string, unknown>[] = [];
    const doc = (kind: string, spec: Record<string, unknown>) => docs.push({ apiVersion: CONTENT, kind, metadata: { name: `${name}-${kind.toLowerCase()}` }, spec });
    if (m.images?.length) doc("Images", { images: m.images });
    if (m.charts?.length) {
        doc("Charts", {
            charts: m.charts.map(({ addImages, addDependencies, ...c }) => ({
                ...c,
                ...(addImages ? { "add-images": true } : {}),
                ...(addDependencies ? { "add-dependencies": true } : {}),
            })),
        });
    }
    if (m.files?.length) doc("Files", { files: m.files });
    return docs.map(d => stringify(d, { lineWidth: 0 })).join("---\n");
}

/** The HaulManifests named, rendered: the files a Hauler store syncs, `<name>.yaml` each. */
export function haulManifestFiles(names: string[], manifests: Record<string, string>): Record<string, string> {
    return Object.fromEntries(names.map(n => {
        if (manifests[n] === undefined) throw new Error(`no HaulManifest "${n}"`);
        return [`${n}.yaml`, manifests[n]];
    }));
}
