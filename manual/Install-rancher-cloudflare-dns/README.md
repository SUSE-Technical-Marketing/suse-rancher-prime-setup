# Install Rancher with Let's Encrypt Certificates using Cloudflare DNS Challenge

This project automates the setup of Rancher using K3s, Cert-Manager, and Let's Encrypt with the Cloudflare DNS challenge.

## 🧩 Files & Templates

- `config.env.example` – Copy this to `config.env` and edit for your domain
- `1-install-k3s.sh` – Installs K3s and sets up kubeconfig for user 'erin'
- `2-install-cert-manager.sh` – Installs Cert-Manager v1.17.2
- `3-install-rancher.sh` – Installs Rancher via Helm using the hostname from config
- `clusterissuer.yaml.template` – Cert-Manager issuer using Cloudflare DNS challenge
- `rancher-cert.yaml.template` – TLS certificate for Rancher ingress
- `bootstrap.sh` – Optional script to render YAMLs and apply everything

## 🚀 Quick Start - Using Batch Scripts

Set up the `config.env` file with your information, run the shell scripts in order, and you will have your main Rancher Cluster up and running with proper certificates from Let's Encrypt.

1. Copy and edit your configuration:

   ```bash
   cp config.env.example config.env
   nano config.env
   ```

   Replace the default values with your own:

   ```bash
   DOMAIN=example.com
   RANCHER_HOSTNAME=rancher.example.com
   CLOUDFLARE_EMAIL=your@example.com
   CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
   ```

2. Run scripts in order:

   ```bash
   1-install-k3s.sh             # Installs K3s
   2-install-cert-manager.sh    # Installs Cert-Manager with CRDs
   3-create-certs.sh            # Creates and applies clusterissuer.yaml and rancher-cert.yaml
   4-install-rancher.sh         # Installs Rancher
   ```

## 🔧 Manual Method

Instead of running the above scripts, you can run the steps manually.

### 1. Copy and Prepare Config Files

```bash
cp config.env.example config.env
```

Edit your config file:

```bash
vi config.env
```

Replace the default values with your own:

```bash
DOMAIN=example.com
RANCHER_HOSTNAME=rancher.example.com
CLOUDFLARE_EMAIL=you@example.com
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
```

### 2. Install K3s

> **Note:** We are installing a specific version of K3s to ensure it is supported by Rancher. Check the Rancher Support Matrix for the latest information.

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.31.6+k3s1" sh -
```

#### configure kube config

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

#### Verify Kubernetes is running

```bash
kubectl get nodes
```

### 3. Install Cert-Manager v1.17.2

#### Add the Cert-Manager Helm repository

```bash
helm repo add jetstack https://charts.jetstack.io --force-update
helm repo update
```

#### Install Cert-Manager with CRDs

```bash
helm install \
  cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --version v1.17.2 \
  --set crds.enabled=true
```

#### Verify the installation

```bash
kubectl rollout status deployment cert-manager -n cert-manager --timeout=120s
kubectl rollout status deployment cert-manager-webhook -n cert-manager --timeout=120s
```

### 4. Create Cloudflare Token Secret

Replace `$CLOUDFLARE_API_TOKEN` with your token:

```bash
kubectl create secret generic cloudflare-api-token-secret \
  --from-literal=api-token="$CLOUDFLARE_API_TOKEN" \
  -n cert-manager
```

### 5. Prepare Cert-Manager Issuer and Certificate Manifests

#### Copy and edit `clusterissuer.yaml`

```bash
cp clusterissuer.yaml.template clusterissuer.yaml
vi clusterissuer.yaml
```

Edit `clusterissuer.yaml` and enter your Cloudflare email in the `email:` field.

#### Copy and edit `rancher-cert.yaml`

```bash
cp rancher-cert.yaml.template rancher-cert.yaml
vi rancher-cert.yaml
```

Edit `rancher-cert.yaml` and enter your Rancher hostname in the `commonName:` field.

### 6. Apply Certificates and Create Namespace

```bash
kubectl create namespace cattle-system
kubectl apply -f clusterissuer.yaml
kubectl apply -f rancher-cert.yaml
```

### 7. Add the Rancher Helm Repository

```bash
helm repo add rancher-latest https://releases.rancher.com/server-charts/latest
helm repo update
```

### 8. Install Rancher

Make sure to update with `--set hostname=$RANCHER_HOSTNAME` with your hostname:

```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=$RANCHER_HOSTNAME \
  --set ingress.tls.source=secret \
  --set ingress.ingressClassName=traefik \
  --set privateCA=false \
  --set replicas=1 \
  --set global.cattle.psp.enabled=false \
  --set bootstrapPassword=admin
kubectl rollout status deployment rancher -n cattle-system --timeout=300s
```
