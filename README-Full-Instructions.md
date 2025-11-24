# Lab Setup Instructions

## Prerequisites

### Domain Setup

To create a production-like environment, we use real TLS certificates issued by Let's Encrypt (free) and DNS services hosted through Cloudflare (also free). You only need to own a domain and configure it in your Cloudflare account.

- Domain: `dna-42.com`
- Cloudflare DNS Token
- Cloudflare Email Address

### Cluster Requirements

You can run as many or as few parts of the lab as you wish. To run the full setup, you will need the following three clusters:

#### 1. Rancher Management Cluster
- DNS Domain: `rancher.dna-42.com`
- Resources:
  - Cores: 2
  - RAM: 6 GB
  - Storage: 60 GB
- Purpose: Hosts the Rancher Management Interface

#### 2. Infrastructure Cluster (Longhorn, Registry, Security)
- DNS Domain: `hangar-bay.dna-42.com`
  - Subdomains:
    - `longhorn.hangar-bay.dna-42.com`
    - `security.hangar-bay.dna-42.com`
    - `registry.hangar-bay.dna-42.com`
- Resources:
  - Cores: 4
  - RAM: 16 GB
  - Storage: 100-300 GB
- Purpose: Provides persistent storage, container registry, and security services

#### 3. Observability Cluster
- DNS Domain: `radar-station.dna-42.com`
  - Subdomains:
    - `longhorn.radar-station.dna-42.com`
    - `observability.radar-station.dna-42.com`
- Kubernetes Distribution: k3s
- Resources:
  - Cores: 10
  - RAM: 32 GB
  - Storage: 300-500 GB
- Purpose: Hosts monitoring and observability tools

---

# Build the Lab Clusters

## Installing Rancher

Rancher version: `2.11.1+`

Install the latest version of Rancher with proper Certificates. Here are 2 guides if you need help.

[Install Rancher with Cloudflare DNS](Install-rancher-cloudflare-dns/README.md)

[Install Rancher with BYO Certificates](Install-rancher-byo-certs/README.md)

### Post-Installation Configuration

After installing Rancher:

#### 1. Change `agent-tls-mode to system-store`

- Access the Rancher UI at: `https://rancher.dna-42.com`
- Configure Global Settings:
  - Navigate to **Global Settings → Settings → agent-tls-mode**
  - Set the value to `system-store`

![system-store](/assets/rancher-global-settings.gif)
---

#### 2. Add Secrets
=== Add Secrets to Rancher Manager (local)

There's a ton of secrets needed these are not stored in the repo. Instead you need to manually create this secrets in the Rancher Manager cluster.

Edit and customize this `local-secret.yaml` with your various authentication methods and deploy it to your local cluster

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: application-collection-basicauth
  namespace: fleet-default
type: kubernetes.io/basic-auth
stringData:
  username: <your_appco_username>
  password: <your_appco_password>
---
apiVersion: v1
kind: Secret
metadata:
  name: scc-suse-basicauth
  namespace: fleet-default
type: kubernetes.io/basic-auth
stringData:
  username: <your_scc_user>
  password: <your_scc_password>
```

![Import Local Secrets](/assets/rancher-local-import-secrets.gif)

## Installing the Downstream Infrastructure Cluster

Use the Rancher UI to create a downstream cluster with the following configuration:

- Cluster Type: RKE2
- Cluster Name: `hangar-bay`

Once the cluster is active, verify accessibility at `hangar-bay.dna-42.com`.

## Installing the Downstream Observability Cluster

Use the Rancher UI to create a downstream cluster with the following configuration:

- Cluster Type: K3s
- Traefik Disabled: Yes
- Cluster Name: `radar-station`

Once the cluster is active, verify accessibility at `radar-station.dna-42.com`.

# Configure Clusters for Fleet-Based Deployment

## Create Configuration YAML Files

Every downstream cluster needs to have the `downstream-secrets.yaml` deployed

First, customize the YAML files containing your authentication details, such as application collection tokens and Cloudflare tokens.

`downstream-cluster-fleet.yaml`

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: fleet-secrets
  namespace: kube-system
type: Opaque
stringData:
  appco-values.yaml: |
    username: <your_appco_username>
    token: <your_appco_token>
  suse-registry-values.yaml: |
    username: <your_scc_user>
    token: <your_scc_password>
  cert-manager-values.yaml: |
    email: <your_letsencrypt_email>
    cloudflare:
      token: <your_cloudflare_token>
  harbor-values.yaml: |
    registry:
      credential:
        access_key: <your_appco_username>
        access_secret: <your_appco_token>
  suse-observability-values.yaml: |
    stackstate:
        license:
          key: "xxxx-xxxx-xxxx"
```

## Apply YAML Files to Clusters

Apply the `downstream-cluster-fleet.yaml` to all downstream clusters. This sets up the application collection, SCC configuration, and related settings.

### On `hangar-bay` and `radar-station`

Use the Rancher UI to deploy the `downstream-cluster-fleet.yaml` file to both `hangar-bay` and `radar-station` clusters.



## Set Up Hosted Domain Names

Using the terminal provided by the Rancher UI in your local cluster, annotate the downstream clusters to specify their hosted domain for certificate creation:

```bash
kubectl annotate cluster.provisioning.cattle.io -n fleet-default hangar-bay "hosted-domain=dna-42.com"

kubectl annotate cluster.provisioning.cattle.io -n fleet-default radar-station "hosted-domain=dna-42.com"
```

## Configure Fleet to Install Traefik Ingress on `radar-station`

The k3s cluster `radar-station` does not yet have an ingress controller. Assign a label so Fleet can identify and install Traefik Ingress.

Run the following command in the Rancher UI terminal:

```bash
kubectl label clusters.provisioning.cattle.io -n fleet-default radar-station needs-traefik=true
```

# Start Cluster Deployment via Fleet

## Apply `fleet/lab-setup.yaml`

Use the Rancher UI to apply the `fleet/lab-setup.yaml` configuration to the `local` cluster.

## Wait for Deployment (5-10 minutes)

Monitor both downstream clusters to verify that cert-manager is installed. In the Rancher UI, navigate to the Workloads section and inspect the `cert-manager` namespace. Review the logs to confirm successful deployment.

## Customize Downstream Clusters via Labels

To install additional applications, apply the appropriate label to the target cluster.

Apply one label at a time and wait for the installation to complete before proceeding. Start from the base of the stack (for example, storage first if required).

| Label                         | Description           |
|-------------------------------|-----------------------|
| `needs-storage=true`           | SUSE Storage          |
| `needs-private-registry=true` | SUSE Private Registry |
| `needs-security=true`          | SUSE Security         |
| `needs-observability=true`     | Observability         |

## For Infrastructure Cluster `hangar-bay`

Apply one label at a time and wait for each installation to complete before moving on. Always verify each service by checking the corresponding URL.

### Install SUSE Storage

Apply the following label via the Rancher UI:

```bash
needs-storage=true
```

Once deployed, verify accessibility at:

```
https://longhorn.hangar-bay.dna-42.com
```

### Install SUSE Security

Apply the following label:

```bash
needs-security=true
```

Verify at:

```
https://security.hangar-bay.dna-42.com
```

### Install SUSE Registry

Apply the following label:

```bash
needs-private-registry=true
```

Verify at:

```
https://registry.hangar-bay.dna-42.com
```

## For Observability Cluster `radar-station`

Apply one label at a time and wait for each installation to complete before proceeding. Always verify each service by checking the corresponding URL.

### Install SUSE Storage

Apply the following label:

```bash
needs-storage=true
```

Once deployed, verify accessibility at:

```
https://longhorn.radar-station.dna-42.com
```

### Install SUSE Observability

Apply the following label:

```bash
needs-observability=true
```

Once deployed, verify accessibility at:

```
https://observability.radar-station.dna-42.com
```

# Configure SUSE Observability

## Add the Agent to the Downstream Cluster

You can add the SUSE Observability Helm repository using either of the following methods:

**Option 1: Rancher UI**

- Navigate to **Apps → Repositories** in the Rancher UI.
- Add a new Helm repository with the following URL:

  ```
  https://charts.rancher.com/server-charts/prime/suse-observability
  ```

**Option 2: Command Line**

```bash
helm repo add suse-observability https://charts.rancher.com/server-charts/prime/suse-observability
helm repo update
```

## Additional Notes

- Ensure DNS records correctly point domains to your cluster IPs.
- Regularly monitor resource utilization across clusters.
- Verify SSL certificates and renew them as needed.