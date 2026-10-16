#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS="$DIR/certs"
mkdir -p "$CERTS"

if [[ -f "$CERTS/cert.pem" && -f "$CERTS/key.pem" ]]; then
  echo "Certificati già presenti in $CERTS"
  exit 0
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
HOSTNAME="$(hostname)"
MDFULL="$(hostname).local"

SAN="DNS:${HOSTNAME},DNS:${MDFULL},DNS:localhost,IP:127.0.0.1"
if [[ -n "$IP" ]]; then
  SAN="$SAN,IP:${IP}"
fi

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout "$CERTS/key.pem" -out "$CERTS/cert.pem" \
  -subj "/CN=${HOSTNAME}" \
  -addext "subjectAltName=${SAN}" 2>/dev/null

echo "Certificati generati in $CERTS"
echo "SAN: ${SAN}"
