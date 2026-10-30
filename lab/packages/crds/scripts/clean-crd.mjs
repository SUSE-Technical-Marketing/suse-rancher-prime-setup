// Reads a CRD as JSON (kubectl get crd <name> -o json) on stdin and writes it to <file> as YAML,
// without status and server-set metadata, so the sources only change when the schema does.
import * as fs from "node:fs";
import { stringify } from "yaml";

const [file] = process.argv.slice(2);
const crd = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {
    apiVersion: crd.apiVersion,
    kind: crd.kind,
    metadata: { name: crd.metadata.name },
    spec: crd.spec,
};
fs.writeFileSync(file, stringify(out, { lineWidth: 0 }));
