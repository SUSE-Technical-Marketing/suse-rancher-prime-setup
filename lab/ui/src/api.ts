// The client for the lab UI server's API (server/index.ts); its types are in api-types.ts.

import type { Catalog, CheckResult, LabFileEntry, LabFileText } from "./api-types";

export type * from "./api-types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Not JSON: not the lab UI's server answering (Vite's proxy with the server down, another server),
    // or a crash. Say so, with what came back, instead of the browser's parse error ("The string did
    // not match the expected pattern" in Safari, "Unexpected token" elsewhere).
    const text = await res.text();
    let data: any;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        const shown = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        throw Object.assign(new Error(`the lab UI's server didn't answer ${method} ${url} (HTTP ${res.status}${shown ? `: ${shown}` : ""}). Is it running? Start it with "mise run ui" in lab/ (or "mise run dev" in lab/ui) and check its console.`), { status: res.status });
    }
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
    return data as T;
}

export const api = {
    catalog: () => call<Catalog>("GET", "/api/catalog"),
    labs: () => call<LabFileEntry[]>("GET", "/api/labs"),
    lab: (file: string) => call<LabFileText>("GET", `/api/labs/${encodeURIComponent(file)}`),
    save: (file: string, text: string, overwrite: boolean) => call<LabFileEntry>("PUT", `/api/labs/${encodeURIComponent(file)}`, { text, overwrite }),
    check: (text: string, name: string) => call<CheckResult>("POST", "/api/check", { text, name }),
};
