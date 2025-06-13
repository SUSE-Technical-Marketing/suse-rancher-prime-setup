# Common CRDs component

## Overview
This component contains all the CRDs that are needed by our IaC setup for Rancher and Apps.

## Adding a new CRD
1. Add the CRD to the `src` directory.
```
$ kubectl get crd <crd-name> -o yaml > src/<crd-name>.yaml
```
2. Run `pnpm generate` to generate the TypeScript code for the CRD.

