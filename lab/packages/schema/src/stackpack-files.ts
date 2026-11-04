import * as path from "node:path";

/** Where `lab stackpacks` puts the StackPacks it builds from source (`lab/.cache/stackpacks/`, not in git). */
export const STACKPACK_DIR = path.resolve(__dirname, "..", "..", "..", ".cache", "stackpacks");

/** A built StackPack's file: `<name>-<version>.sts`, as its packaging script names it. */
export const stackPackFile = (name: string, version: string) => path.join(STACKPACK_DIR, `${name}-${version}.sts`);
