# Setting up Proxy Cache in SUSE Private Registry and Rancher Integration

## Introduction

This document provides a comprehensive guide for configuring SUSE Private Registry (based on Harbor) to act as a proxy cache for several common public container image registries. It also details how to integrate this setup with Rancher-managed Kubernetes clusters (RKE2/K3s) to redirect all container image pulls through the configured proxy caches.

Using a proxy cache offers significant benefits, including:
* **Reduced Latency:** Images are pulled from a local cache, speeding up deployments.
* **Bandwidth Savings:** Images are fetched from external registries only once.
* **Improved Reliability:** Reduces dependency on the availability and performance of external registries.
* **Enhanced Security:** Allows for centralized control and scanning of images.
* **Air-Gapped Support:** Facilitates the use of images in environments with restricted internet access after initial cache population.

We will configure proxy caches for the following upstream registries:
* GitHub Container Registry (`ghcr.io`)
* Quay.io (`quay.io`)
* Docker Hub (`docker.io` / `registry-1.docker.io`)
* SUSE Application Collection (specific SUSE registry)

And create the following Harbor projects to serve these caches:
* `application-collection`
* `docker`
* `docker-io`
* `gher`
* `library`
* `quay`

## Prerequisites

* **SUSE Private Registry:** An installed and operational instance (Harbor-based).
* **Administrative Access:** Credentials for admin-level access to the SUSE Private Registry web UI.
* **Rancher:** A running Rancher instance managing your Kubernetes cluster(s).
* **Kubernetes Cluster:** An RKE2 or K3s cluster managed by Rancher.
* **`kubectl` Access:** Configured `kubectl` to interact with your Kubernetes cluster.
* **Node Access (Optional but Recommended):** SSH access to your Kubernetes nodes for applying `registries.yaml` and troubleshooting.
* **Upstream Credentials (Optional):**
    * For Docker Hub, while public images can be pulled anonymously, using a Docker Hub account (even a free one) for the endpoint configuration is highly recommended to avoid strict rate limits.
    * For other private repositories you might want to proxy (not covered by the public list in this guide), you'll need appropriate credentials.

## Part 1: Configuring Registry Endpoints in SUSE Private Registry

A Registry Endpoint in Harbor defines the connection to an upstream (remote) container registry.

**General Steps:**
1.  Log in to your SUSE Private Registry (Harbor) Web UI with administrative privileges.
2.  Navigate to **"Administration"** -> **"Registries"**.
3.  Click on **"+ New Endpoint"**.

Now, create the following endpoints one by one:

### 1. GitHub Container Registry (`ghcr.io`)
* **Endpoint Name:** `ghcr.io-proxy` (or your preferred name)
* **Provider:** Select **"GitHub Container Registry"**. If not available, **"Docker Registry"** can often be used.
* **Endpoint URL:** `https://ghcr.io`
* **Access ID (Username):** (Optional) Your GitHub username or a PAT with `read:packages` scope if you need to access private packages or avoid potential anonymous access restrictions. For public repos, this can often be left blank.
* **Access Secret (Password/Token):** (Optional) Your GitHub PAT.
* **Verify Remote Cert:** Keep enabled (checked).
* Click **"Test Connection"**. It should succeed.
* Click **"OK"** to save.

### 2. Quay.io
* **Endpoint Name:** `quay-proxy`
* **Provider:** Select **"Quay"**. If not available, use **"Docker Registry"**.
* **Endpoint URL:** `https://quay.io`
* **Access ID (Username):** (Optional) Your Quay.io username or robot account username if accessing private images or for higher rate limits.
* **Access Secret (Password/Token):** (Optional) Your Quay.io password or robot account token.
* **Verify Remote Cert:** Keep enabled.
* Click **"Test Connection"**.
* Click **"OK"**.

### 3. Docker Hub (for `docker.io` pulls)
This endpoint will serve as the primary proxy for Docker Hub.
* **Endpoint Name:** `docker-io-proxy`
* **Provider:** Select **"Docker Hub"**. If not available, use **"Docker Registry"**.
* **Endpoint URL:** `https://registry-1.docker.io` (This is the actual registry backend for Docker Hub).
* **Access ID (Username):** **Highly Recommended.** Your Docker Hub username.
* **Access Secret (Password/Token):** **Highly Recommended.** Your Docker Hub password or an Access Token. Using credentials helps avoid strict anonymous pull rate limits.
* **Verify Remote Cert:** Keep enabled.
* Click **"Test Connection"**.
* Click **"OK"**.

### 4. Docker Hub (alternative/additional, if needed for clarity or separate project mapping)
You might want a distinct endpoint if you map the `dockerhub-proxy` name explicitly to a different project than `docker-io-proxy`, though typically one Docker Hub endpoint is sufficient. If `docker-io-proxy` is already created, this might be redundant unless specific configuration differences are needed. For this guide, we'll assume `docker-io-proxy` covers all Docker Hub needs. If you still wish to create it:
* **Endpoint Name:** `dockerhub-proxy`
* **Provider:** Select **"Docker Hub"** or **"Docker Registry"**.
* **Endpoint URL:** `https://hub.docker.com` or `https://registry-1.docker.io`.
* **Access ID (Username):** Your Docker Hub username.
* **Access Secret (Password/Token):** Your Docker Hub password or Access Token.
* **Verify Remote Cert:** Keep enabled.
* Click **"Test Connection"**.
* Click **"OK"**.

### 5. SUSE Application Collection
The exact URL for the SUSE Application Collection's container registry is needed here. Please replace `https://<suse-app-collection-registry-url>` with the actual URL.
* **Endpoint Name:** `application-collection-endpoint` (or just `application-collection` if Harbor allows it for endpoints)
* **Provider:** Likely **"Docker Registry"** or a specific SUSE provider if listed.
* **Endpoint URL:** `https://<suse-app-collection-registry-url>` **(Replace with actual URL)**
* **Access ID (Username):** (If required by SUSE Application Collection)
* **Access Secret (Password/Token):** (If required)
* **Verify Remote Cert:** Keep enabled.
* Click **"Test Connection"**.
* Click **"OK"**.

## Part 2: Creating Proxy Cache Projects in SUSE Private Registry

A Proxy Cache Project in Harbor links to an Endpoint and stores the cached images.

**General Steps:**
1.  In the Harbor Web UI, navigate to **"Projects"**.
2.  Click on **"+ New Project"**.
3.  For each project listed below:
    * Set the **Project Name**.
    * **Access Level:** Choose **"Public"** (recommended for ease of access by Kubernetes nodes within your network).
    * Enable the **"Proxy Cache"** slider/checkbox.
    * From the **"Upstream Registry Endpoint"** dropdown, select the corresponding endpoint created in Part 1.

Create the following projects:

### 1. Project: `application-collection`
* **Project Name:** `application-collection`
* **Proxy Cache:** Enabled
* **Upstream Registry Endpoint:** Select `application-collection-endpoint` (or the name you gave it).

### 2. Project: `docker`
This project can be used for general Docker Hub images, potentially for those explicitly pulled as `docker.io/...` if your `registries.yaml` differentiates.
* **Project Name:** `docker`
* **Proxy Cache:** Enabled
* **Upstream Registry Endpoint:** Select `docker-io-proxy` (or `dockerhub-proxy` if you created and prefer that for this mapping).

### 3. Project: `docker-io`
This project will be the primary cache for Docker Hub images.
* **Project Name:** `docker-io`
* **Proxy Cache:** Enabled
* **Upstream Registry Endpoint:** Select `docker-io-proxy`.

### 4. Project: `gher` (for GitHub Container Registry)
* **Project Name:** `gher`
* **Proxy Cache:** Enabled
* **Upstream Registry Endpoint:** Select `ghcr.io-proxy`.

### 5. Project: `library`
The `library` project is often used in Harbor as a target for official Docker Hub images that don't have an organization prefix (e.g., `nginx` is `library/nginx`).
* **Project Name:** `library`
* **Proxy Cache:** Enabled
* **Upstream Registry Endpoint:** Select `docker-io-proxy`.

### 6. Project: `quay`
* **Project Name:** `quay`
* **Proxy Cache:** Enabled
* **Upstream Registry Endpoint:** Select `quay-proxy`.

Click **"OK"** to save each project after configuration.

## Part 3: Integrating Proxy Cache with Rancher (RKE2/K3s)

To make your Kubernetes cluster use these proxy caches, you need to configure the container runtime (containerd) on each node. This is done using a `registries.yaml` file.

**1. Understanding `registries.yaml`**

This file tells `containerd` where to find mirrors (your proxy caches) for specified registries.

**File Locations:**
* **RKE2:** `/etc/rancher/rke2/registries.yaml`
* **K3s:** `/etc/rancher/k3s/registries.yaml`

**2. Creating the `registries.yaml` Configuration**

Let `<suse-private-registry-fqdn>` be the fully qualified domain name of your SUSE Private Registry (e.g., `harbor.yourcompany.com`).

```yaml
# /etc/rancher/rke2/registries.yaml or /etc/rancher/k3s/registries.yaml
mirrors:
  # Docker Hub - Primary target for docker.io and unprefixed images
  docker.io:
    endpoint:
      - "https://<suse-private-registry-fqdn>/v2/docker-io" # Main Docker Hub proxy
      - "https://<suse-private-registry-fqdn>/v2/library"   # For library/ images
      # You might also add the 'docker' project if you have specific redirection rules for it.
      # - "https://<suse-private-registry-fqdn>/v2/docker"

  # GitHub Container Registry
  ghcr.io:
    endpoint:
      - "https://<suse-private-registry-fqdn>/v2/gher"

  # Quay.io
  quay.io:
    endpoint:
      - "https://<suse-private-registry-fqdn>/v2/quay"

  # SUSE Application Collection
  # Replace <suse-app-collection-registry-url-hostonly> with the HOSTNAME of the SUSE App Collection registry
  # e.g., if URL is [https://registry.suse.com](https://registry.suse.com), this would be registry.suse.com
  "<suse-app-collection-registry-url-hostonly>":
    endpoint:
      - "https://<suse-private-registry-fqdn>/v2/application-collection"

configs: {} # Leave empty or configure further as needed for auth to Harbor itself

# --- IMPORTANT ---
# If your SUSE Private Registry (Harbor) uses a self-signed certificate
# or a CA not trusted by your nodes, you MUST configure TLS settings.
# Example for an insecure registry (NOT RECOMMENDED for production):
#
# configs:
#   "https://<suse-private-registry-fqdn>":
#     tls:
#       insecure_skip_verify: true
#
# Example for a custom CA certificate:
# 1. Ensure the CA certificate file (e.g., /etc/ssl/certs/my-harbor-ca.crt)
#    is present on ALL Kubernetes nodes.
# 2. Configure as follows:
#
# configs:
#   "https://<suse-private-registry-fqdn>":
#     tls:
#       ca_file: "/etc/ssl/certs/my-harbor-ca.crt"
#
# If your Harbor instance requires authentication even for pulling from public proxy
# projects (not typical for proxies but possible), you'd add 'auth' here:
#
# configs:
#   "https://<suse-private-registry-fqdn>":
#     auth:
#       username: "your_harbor_pull_user"
#       password: "your_harbor_pull_password"
#     tls: # Add TLS config if needed
#       # ca_file: "/etc/ssl/certs/my-harbor-ca.crt"