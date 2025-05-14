
The Cloud Native Tech Lab makes it easy for you to build and deploy demo environments that leverage SUSE technology, using either your own lab equipment or running entirely in the cloud.

This document outlines the setup procedure for a demo lab environment utilizing Rancher and Kubernetes clusters.

You have several options for installation, ranging from manual to fully automated:

  - `BYO VMs` - You provide the VMs, and we help you provision them.
  - `Harvester` Fully Automated - Use Pulumi to configure a previously installed Harvester Cluster (coming soon).
  - `Cloud Deployment` (coming soon).

When you create a downstream cluster, each cluster is provisioned with the following by default:

- `Secrets` - Imported from `downstream-cluster.yaml`, including SCC Credential, Application Collection Credentials, Cloudflare Credentials, and SUSE Observability License
- `Sprouter` - A utility that copies secrets to all namespaces (such as application-collection, scc, etc.).
- `Cert-Manager` - Installed and configured using the contents of `downstream-cluster.yaml` and the `hosted-domain` annotation.
- `Application Collection in Rancher UI` - Defined as a repository in the Rancher UI.

Once the base system is installed, you can enable additional capabilities on any cluster simply by adding a Kubernetes label. Fleet will handle the rest. For example, if you need a SUSE Private Registry for a demo, just add the label `needs-private-registry=true`, and within minutes, Fleet will install and configure the SUSE private registry, including proxy cache setup for the Application Collection and ingress configuration.

Currently supported add-ons include:

- `needs-storage`  - Installs Longhorn and sets up a default storage class with 1 replica.
- `needs-security` - Installs SUSE Security and configures autoscan.
- `needs-ingress-nginx` - Installs and configures ingress-nginx, required for all k3s clusters (to support certificates).
- `needs-private-registry` - Installs SUSE Private Registry and creates a proxy cache for the Application Collection using your credentials.

## Instructions on installing and building the lab

Full instructions with step by set commands

[Full Install Instructions](README-Full-Instructions.md)

Already Got Clusters running and just need the fleet files?

[Quick Start Instructions](README-QuickStart.md)