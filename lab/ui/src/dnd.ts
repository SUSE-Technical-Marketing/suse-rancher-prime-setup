import { shallowRef } from "vue";

// What's being dragged. `dragover` can't read the data of a drag, so drop targets look at this to
// decide whether they accept it (and light up).
export type Payload =
    | { type: "block"; block: Block }
    | { type: "profile"; name: string; from?: number }
    | { type: "host"; index: number };

export type Block = "Harvester" | "HarvesterVM" | "RancherVM" | "Machine" | "DownstreamCluster" | "AwsSite" | "Ec2Cluster" | "EksCluster" | "MetalCluster" | "K3kCluster";

export const dragging = shallowRef<Payload>();
const MIME = "application/x-lab-composer";

export function start(e: DragEvent, payload: Payload) {
    dragging.value = payload;
    e.dataTransfer?.setData(MIME, JSON.stringify(payload));
    e.dataTransfer?.setData("text/plain", payload.type === "profile" ? payload.name : payload.type);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = payload.type === "block" ? "copy" : "copyMove";
}

export function end() {
    dragging.value = undefined;
}

export function read(e: DragEvent): Payload | undefined {
    const raw = e.dataTransfer?.getData(MIME);
    if (raw) {
        try { return JSON.parse(raw) as Payload; } catch { /* fall through */ }
    }
    return dragging.value;
}

/**
 * `v-on` handlers for a drop target: it accepts what `accepts` says yes to, shows `over` while a
 * drag is above it, and calls `drop`.
 */
export function target(accepts: (p: Payload) => boolean, drop: (p: Payload) => void, over?: (on: boolean) => void) {
    return {
        dragover(e: DragEvent) {
            if (!dragging.value || !accepts(dragging.value)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = dragging.value.type === "block" || (dragging.value.type === "profile" && dragging.value.from === undefined) ? "copy" : "move";
            over?.(true);
        },
        dragleave(e: DragEvent) {
            if (e.currentTarget instanceof Node && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
            over?.(false);
        },
        drop(e: DragEvent) {
            const p = read(e);
            over?.(false);
            if (!p || !accepts(p)) return;
            e.preventDefault();
            e.stopPropagation();
            end();
            drop(p);
        },
    };
}
