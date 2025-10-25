#!/bin/bash
set -e
source ./config.env
kubectl create namespace cattle-system || true
helm repo add rancher-prime https://charts.rancher.com/server-charts/prime
helm repo update
helm install rancher rancher-prime/rancher \
  --namespace cattle-system \
  --set hostname=$RANCHER_HOSTNAME \
  --set ingress.tls.source=secret \
  --set ingress.ingressClassName=traefik \
  --set privateCA=false \
  --set replicas=1 \
  --set global.cattle.psp.enabled=false \
  --set bootstrapPassword=admin  \
  --version=2.12.2
kubectl rollout status deployment rancher -n cattle-system --timeout=300s
