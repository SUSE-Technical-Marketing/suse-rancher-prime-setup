# @lab/crds

Typed Pulumi classes for the custom resources the lab creates, generated with
[crd2pulumi](https://github.com/pulumi/crd2pulumi) from `crd-sources/`. Don't edit `generated/`.

    mise run crds        # regenerate generated/ from crd-sources/

## Adding or refreshing a CRD

Take the CRD from a cluster running the version the lab targets, cleaned of status and
server-set metadata:

    kubectl get crd <name> -o json | node scripts/clean-crd.mjs crd-sources/<name>.yaml
    mise run crds

Current sources: Harvester v1.9.0 (asgard), Rancher v2.15.2, cert-manager v1.20.2, MetalLB 0.16.1 (from its chart's `charts/crds`).
