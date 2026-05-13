# @suse-tmm/harvester

Pulumi components for managing Harvester HCI resources.

## Installation

```bash
npm install @suse-tmm/harvester
# or
pnpm add @suse-tmm/harvester
```

## Usage

```typescript
import * as harvester from "@suse-tmm/harvester";

// Create base Harvester resources
const base = new harvester.HarvesterBase("my-cluster", {
    storageClasses: [...],
    networks: [...],
    images: {...},
    keypairs: [...],
});

// Create a VM
const vm = new harvester.HarvesterVm("my-vm", {
    kubeconfig: harvesterKubeconfig,
    virtualMachine: {
        namespace: "default",
        resources: { cpu: 2, memory: "4Gi" },
        network: { name: "my-network", namespace: "default" },
        disk: { name: "disk0", size: "20Gi", imageId: "...", storageClassName: "..." },
    },
});
```

## Generated CRD Types

This package includes generated Pulumi types for Harvester CRDs:

```typescript
import { harvesterhci, kubevirt, k8s, network, loadbalancer } from "@suse-tmm/harvester";

// Use CRD types directly
const image = new harvesterhci.v1beta1.VirtualMachineImage("my-image", {...});
const vm = new kubevirt.v1.VirtualMachine("my-vm", {...});
```

## Regenerating CRD Types

To regenerate the CRD types from updated YAML definitions:

```bash
# Update CRD YAMLs in crd-sources/
pnpm generate
pnpm build
```

## Dependencies

- `@suse-tmm/common` - Shared utilities for cloud-init, Rancher client, etc.
- `@pulumi/pulumi` - Pulumi SDK
- `@pulumi/kubernetes` - Pulumi Kubernetes provider

## License

Apache-2.0
