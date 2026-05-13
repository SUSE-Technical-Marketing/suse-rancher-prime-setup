#!/bin/bash
set -e
source ./config.env
export RANCHER_HOSTNAME

kubectl create namespace cattle-system || true
helm repo add rancher-latest https://releases.rancher.com/server-charts/latest
helm repo update
helm install rancher rancher-latest/rancher \
  --namespace cattle-system \
  --set hostname=$RANCHER_HOSTNAME \
  --set ingress.tls.source=secret \
  --set privateCA=false \
  --set replicas=1 \
  --set global.cattle.psp.enabled=false \
  --set bootstrapPassword=admin
kubectl rollout status deployment rancher -n cattle-system --timeout=300s

