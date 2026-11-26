import { describe, expect, it } from "vitest";
import { formatDiagnostic, loadLab } from "../src";
import { labFiles, labsFixture } from "./labs-fixture";

// Every file in labs/ must load without errors. These files are the examples people copy, so one
// that no longer validates (a field that moved, a renamed profile) is a bug in the repository, not
// something to find out when someone tries it.

const fixture = labsFixture();

describe("labs/", () => {
    it("has lab files to check", () => {
        expect(labFiles.length).toBeGreaterThan(10);
    });

    it.each(labFiles)("%s loads without errors", file => {
        const result = loadLab({ labFile: fixture.labPath(file), personalConfig: fixture.personalConfig() });
        expect(result.diagnostics.errors.map(formatDiagnostic)).toEqual([]);
        expect(result.lab).toBeDefined();
    });
});
