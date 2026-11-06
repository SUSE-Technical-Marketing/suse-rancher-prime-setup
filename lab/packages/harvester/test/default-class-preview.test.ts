import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { MockMonitor } from "@pulumi/pulumi/runtime/mocks";
import { expect, it } from "vitest";
import { HarvesterBase } from "../src/base";

it("previews a non-default class and orders reset, creation, promotion, and VM readiness", async () => {
    const registered: pulumi.runtime.MockResourceArgs[] = [];
    await pulumi.runtime.setMocks({
        newResource(args) {
            registered.push(args);
            if (args.type === "kubernetes:storage.k8s.io/v1:StorageClass") {
                // The existing default is untouched during preview; Harvester rejects a second.
                if (args.inputs.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true") {
                    throw new Error("default storage class harvester-longhorn already exists");
                }
            }
            return { id: `${args.name}-id`, state: args.inputs };
        },
        call: args => args.inputs,
    }, "lab", "preview", true);
    const monitor = pulumi.runtime.getMonitor();
    if (!(monitor instanceof MockMonitor)) throw new Error("expected Pulumi's mock monitor");
    const mockMonitor: MockMonitor = monitor;
    const dependencies = new Map<string, string[]>();
    const registerResource = mockMonitor.registerResource.bind(mockMonitor);
    mockMonitor.registerResource = (request: { getName(): string; getDependenciesList(): string[] }, callback) => {
        dependencies.set(request.getName(), request.getDependenciesList());
        return registerResource(request, callback);
    };
    const provider = new k8s.Provider("hv/provider", { kubeconfig: "{}" });
    const base = new HarvesterBase("hv", {
        harvester: {
            name: "hv", url: "https://hv.example.com", credentials: "{{ secrets.hv }}", insecure: false,
            clusterNetwork: "mgmt", defaultNetwork: "untagged", networks: [], profiles: {}, chartValues: {},
            storageClass: { name: "longhorn-single", replicas: 1, imageClass: "longhorn-single", parameters: {} },
            images: [],
        },
        namespace: "lab-test", domain: "example.com", usedNetworks: [],
        charts: { dhcpController: { chart: "dhcp", repo: "https://example.com", version: "1" } },
        timeouts: { harvesterAddon: 900, image: 3600, loadBalancerCleanup: 300 },
    }, { provider });
    const ready = await new Promise<string[]>(resolve => { pulumi.all(base.ready.map(r => r.urn)).apply(resolve); });
    const storageClass = registered.find(r => r.name === "hv/storageclass")!;
    expect(storageClass.inputs.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"]).toBeUndefined();
    expect(storageClass.inputs.parameters.numberOfReplicas).toBe("1");
    expect(dependencies.get("hv/storageclass")).toEqual(expect.arrayContaining([
        expect.stringContaining("::hv/default-class-reset"),
    ]));
    expect(dependencies.get("hv/default-class")).toEqual(expect.arrayContaining([
        expect.stringContaining("::hv/storageclass"),
    ]));
    expect(ready).toEqual(expect.arrayContaining([expect.stringContaining("::hv/default-class")]));
});
