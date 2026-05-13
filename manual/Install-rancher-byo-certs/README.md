# Install Rancher with a Wildcard Certificate

This project automates the setup of Rancher using K3s, Cert-Manager, and wildcard certificates.

You will need:

- `cert` = `fullchain.pem`
- `key` = `privkey.pem`

## 🧩 Files & Templates

- `config.env.example` – Copy this to `config.env` and edit for your domain.
- `1-install-k3s.sh` – Installs K3s and sets up kubeconfig for user 'erin'.
- `2-create-secret.sh` – Creates secrets from `fullchain.pem` and `privkey.pem`.
- `3-install-rancher.sh` – Installs Rancher via Helm using the secret created in the previous step.

## 🚀 Quick Start – Using Batch Scripts

1. Copy and edit your configuration:

   ```bash
   cp config.env.example config.env
   nano config.env
   ```

2. Run the scripts in order:

   ```bash
   chmod +x *.sh
   ./1-install-k3s.sh      # Installs K3s
   ./2-create-secret.sh    # Creates secrets from cert and key
   ./3-install-rancher.sh  # Installs Rancher
   ```

## 🔧 Manual Installation Method

### 1. Prepare Configuration

Copy the example config and edit it with your domain information:

```bash
cp config.env.example config.env
nano config.env
```

Update the following variables in `config.env`:

```env
DOMAIN=example.com
RANCHER_HOSTNAME=rancher.example.com
```

### 2. Install K3s

Run the following command to install K3s:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.31.6+k3s1" sh -
```

### 3. Set Up Kubeconfig

Export the kubeconfig environment variable:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

Verify that Kubernetes is running:

```bash
kubectl get nodes
```

### 4. Create Secrets for Certificates

Create the namespace for Rancher:

```bash
kubectl create namespace cattle-system
```

Create the TLS secret using your certificate and key:

```bash
kubectl -n cattle-system create secret tls tls-rancher-ingress \
  --cert=fullchain.pem \
  --key=privkey.pem
```

### 5. Install Rancher

Add the Rancher Helm repository and update:

```bash
helm repo add rancher-latest https://releases.rancher.com/server-charts/latest
helm repo update
```

Install Rancher with the specified settings:

```bash
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=$RANCHER_HOSTNAME \
  --set ingress.tls.source=secret \
  --set privateCA=false \
  --set replicas=1 \
  --set global.cattle.psp.enabled=false \
  --set bootstrapPassword=admin

kubectl rollout status deployment rancher -n cattle-system --timeout=300s
```
