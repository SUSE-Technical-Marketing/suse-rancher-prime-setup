import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { ResolvedHarvester } from "@lab/schema";
import { register } from "tsx/cjs/api";
import { describe, expect, it } from "vitest";
import { HarvesterBase } from "../src/base";
import { HarvesterVm } from "../src/vm";

register();

const classes = new Map<string, Record<string, string>>([
    ["external-images", { numberOfReplicas: "2", staleReplicaTimeout: "60", migratable: "true" }],
]);
const registered: pulumi.runtime.MockResourceArgs[] = [];

pulumi.runtime.setMocks({
    newResource(args) {
        registered.push(args);
        const state = { ...args.inputs };
        if (args.type === "kubernetes:storage.k8s.io/v1:StorageClass") {
            classes.set(args.inputs.metadata.name, args.inputs.parameters);
        }
        if (args.type === "kubernetes:harvesterhci.io/v1beta1:VirtualMachineImage") {
            // Harvester 1.8/1.9's create webhook picks the annotation's class BEFORE
            // defaulting that annotation from the target, and overwrites explicit parameters.
            const template = args.inputs.metadata.annotations["harvesterhci.io/storageClassName"];
            state.spec = {
                ...args.inputs.spec,
                storageClassParameters: classes.get(template) ?? { numberOfReplicas: "3" },
            };
            state.status = { storageClassName: `longhorn-${args.inputs.metadata.namespace}-${args.inputs.metadata.name}` };
            classes.set(state.status.storageClassName, state.spec.storageClassParameters);
        }
        return { id: `${args.name}-id`, state };
    },
    call: args => args.inputs,
}, "lab", "test", false);

describe("Harvester image storage", () => {
    it.each([
        { name: "single", replicas: 1, imageClass: "single", expectedReplicas: "1", staleReplicaTimeout: "30" },
        { name: "multiple", replicas: 2, imageClass: "multiple", expectedReplicas: "2", staleReplicaTimeout: "30" },
        { name: "external", replicas: 1, imageClass: "external-images", expectedReplicas: "2", staleReplicaTimeout: "60" },
    ])("uses the image class as the disk policy template: $name", async ({ name, replicas, imageClass, expectedReplicas, staleReplicaTimeout }) => {
        const harvester: ResolvedHarvester = {
            name, url: "https://hv.example.com", credentials: "{{ secrets.hv }}", insecure: false,
            clusterNetwork: "mgmt", defaultNetwork: "untagged", networks: [], profiles: {}, chartValues: {},
            storageClass: {
                name, replicas, imageClass,
                parameters: { numberOfReplicas: "3", staleReplicaTimeout: "30", migratable: "true" },
            },
            images: [{ os: "leap-16", source: { kind: "url", url: "https://example.com/leap.qcow2" } }],
        };
        const provider = new k8s.Provider(`${name}/provider`, { kubeconfig: "{}" });
        const base = new HarvesterBase(name, {
            harvester, namespace: `lab-${name}`, domain: "example.com", usedNetworks: [],
            charts: { dhcpController: { chart: "dhcp", repo: "https://example.com", version: "1" } },
            timeouts: { harvesterAddon: 900, image: 3600, loadBalancerCleanup: 300 },
        }, { provider });
        const image = base.images["leap-16"];
        const vm = new HarvesterVm(`${name}/host`, {
            harvester: name, namespace: base.namespace.metadata.name, vmName: name,
            cpu: 2, memory: "4Gi", disk: "40Gi", image, network: "default/untagged",
            userData: "#cloud-config\n", fixedAddress: "192.0.2.10", timeouts: { start: 900, address: 300 },
        }, { provider });
        await new Promise<void>(resolve => { vm.vm.urn.apply(() => resolve()); });
        const imageId = await new Promise<string>(resolve => { image.id.apply(resolve); });
        const diskClass = await new Promise<string>(resolve => { image.storageClassName.apply(resolve); });

        expect(imageId).toBe(`lab-${name}/leap-16`);
        expect(diskClass).toBe(`longhorn-lab-${name}-leap-16`);
        expect(classes.get(diskClass)).toMatchObject({ numberOfReplicas: expectedReplicas, staleReplicaTimeout, migratable: "true" });
        const imported = registered.find(r => r.name === `${name}/image/leap-16`)!;
        expect(imported.inputs.metadata.annotations["harvesterhci.io/storageClassName"]).toBe(imageClass);
        expect(imported.inputs.spec.targetStorageClassName).toBe(imageClass);
        const disk = registered.find(r => r.name === `${name}/host/disk`)!;
        expect(disk.inputs.spec.storageClassName).toBe(diskClass);
        expect(disk.inputs.metadata.annotations["harvesterhci.io/imageId"]).toBe(imageId);
    }, 30000);
});
