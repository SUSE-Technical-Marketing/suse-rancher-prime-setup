#!/bin/bash
set -e
source ./config.env
export RANCHER_HOSTNAME
export CLOUDFLARE_EMAIL
export CLOUDFLARE_API_TOKEN

echo "[+] Creating Cloudflare secret..."
kubectl create namespace cattle-system || true
kubectl create namespace cert-manager || true
kubectl create secret generic cloudflare-api-token-secret \
  --from-literal=api-token="$CLOUDFLARE_API_TOKEN" \
  -n cert-manager || true

echo "[+] Generating YAML manifests from templates..."
envsubst '${RANCHER_HOSTNAME} ${CLOUDFLARE_EMAIL}' < clusterissuer.yaml.template > clusterissuer.yaml
envsubst '${RANCHER_HOSTNAME}' < rancher-cert.yaml.template > rancher-cert.yaml

echo "[+] Applying issuer and cert..."
kubectl apply -f clusterissuer.yaml
kubectl apply -f rancher-cert.yaml
