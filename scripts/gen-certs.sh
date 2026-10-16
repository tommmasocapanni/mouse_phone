#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS="$DIR/certs"
mkdir -p "$CERTS"

IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
HOSTNAME="$(hostname)"
BONJOUR="$(scutil --get LocalHostName 2>/dev/null || true)"
[[ -z "$BONJOUR" ]] && BONJOUR="${HOSTNAME%%.*}"

SAN="DNS:${BONJOUR}.local,DNS:${HOSTNAME},DNS:localhost,IP:127.0.0.1"
if [[ -n "$IP" ]]; then
  SAN="$SAN,IP:${IP}"
fi

# 1) Root CA locale (creata una sola volta; riusata se presente, così l'iPhone
#    non deve reinstallarla).
if [[ ! -f "$CERTS/rootCA.pem" || ! -f "$CERTS/rootCA-key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout "$CERTS/rootCA-key.pem" -out "$CERTS/rootCA.pem" \
    -subj "/CN=mouse_phone Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  echo "Creata Root CA: $CERTS/rootCA.pem"
else
  echo "Root CA esistente riusata: $CERTS/rootCA.pem"
fi

# 2) Chiave + CSR del server
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -keyout "$CERTS/key.pem" -out "$CERTS/server.csr" \
  -subj "/CN=${HOSTNAME}" 2>/dev/null

# 3) Leaf firmato dalla CA (CA:FALSE + serverAuth) — iOS accetta WSS solo così
cat > "$CERTS/openssl.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${SAN}
EOF

openssl x509 -req -in "$CERTS/server.csr" \
  -CA "$CERTS/rootCA.pem" -CAkey "$CERTS/rootCA-key.pem" -CAcreateserial \
  -days 397 -sha256 -extfile "$CERTS/openssl.ext" \
  -out "$CERTS/leaf.pem" 2>/dev/null

# catena: leaf + CA (il server serve la catena completa)
cat "$CERTS/leaf.pem" "$CERTS/rootCA.pem" > "$CERTS/cert.pem"

rm -f "$CERTS/server.csr" "$CERTS/openssl.ext"
echo "Certificato server (leaf) + catena: $CERTS/cert.pem"
echo "SAN: ${SAN}"
echo
echo "Installa sull'iPhone la CA: src=http://${IP:-<IP>}:8080/ca  (o AirDrop di $CERTS/rootCA.pem)"
