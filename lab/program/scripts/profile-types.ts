// Writes program/generated/profile-settings.ts from the catalog's profiles (mise run profile-types).
import * as fs from "node:fs";
import * as path from "node:path";
import { formatDiagnostic, generateProfileSettingsTs, loadCatalog } from "@lab/schema";

const { diagnostics, catalog } = loadCatalog({ personalConfig: "/dev/null/none" });
for (const d of diagnostics.items) console.error(formatDiagnostic(d));
if (!catalog) process.exit(1);
const file = path.join(__dirname, "..", "generated", "profile-settings.ts");
fs.writeFileSync(file, generateProfileSettingsTs(catalog.profiles));
console.log(`wrote ${path.relative(process.cwd(), file)} (${Object.keys(catalog.profiles).length} profiles)`);
