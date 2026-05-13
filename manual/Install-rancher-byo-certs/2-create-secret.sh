#!/bin/bash
set -e

# Define the certificate files
CERT_FILE="fullchain.pem"
KEY_FILE="privkey.pem"

# Check if the certificate file exists
if [ ! -f "$CERT_FILE" ]; then
    echo "Error: Certificate file '$CERT_FILE' not found."
    echo "Please ensure this script is run from the directory containing '$CERT_FILE' and '$KEY_FILE',"
    echo "or that the files are present in the current directory."
    exit 1
fi

# Check if the private key file exists
if [ ! -f "$KEY_FILE" ]; then
    echo "Error: Private key file '$KEY_FILE' not found."
    echo "Please ensure this script is run from the directory containing '$CERT_FILE' and '$KEY_FILE',"
    echo "or that the files are present in the current directory."
    exit 1
fi

echo "Certificate and key files found. Proceeding with secret creation..."
echo "Creating Secrets"

# Create namespace if it doesn't exist, ignore error if it already exists
kubectl create namespace cattle-system || true

# Create the TLS secret
kubectl -n cattle-system create secret tls tls-rancher-ingress \
    --cert="$CERT_FILE" \
    --key="$KEY_FILE"

echo "Secret 'tls-rancher-ingress' created successfully in 'cattle-system' namespace."