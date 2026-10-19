#!/usr/bin/env bash
# Generates the TEST-ONLY TLS files for the opt-in `mysql-ssl` service in ../docker-compose.mysql.yml (DEV-12035),
# into ./ssl-certs (gitignored):
#   ca.pem / ca-key.pem                 a throwaway CA — paste ca.pem into the connector's CA Certificate field
#   server-cert.pem / server-key.pem    signed by that CA, SAN DNS:localhost + IP:127.0.0.1, so VERIFY_IDENTITY passes
#                                       when the connection's Host is `localhost`
#   wrong-ca.pem                        an unrelated CA, for the "VERIFY_CA with the wrong CA" negative case
# The keys are world-readable on purpose (the container's mysql user must read the bind-mounted server key). They
# protect nothing — never reuse them anywhere.
#
# Usage: server/localdev/mysql/generate-ssl-certs.sh [--force]
#   Skips when the certificates already exist. --force regenerates them; then recreate the container so mysqld
#   loads the new ones: docker compose -f docker-compose.mysql.yml --profile ssl up -d --force-recreate --wait mysql-ssl
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
certificate_output_directory="${script_directory}/ssl-certs"

force_regeneration=false
case "${1:-}" in
  '') ;;
  --force) force_regeneration=true ;;
  *)
    echo "Usage: $0 [--force]" >&2
    exit 2
    ;;
esac

if [[ -f "${certificate_output_directory}/server-cert.pem" && "${force_regeneration}" == false ]]; then
  echo "Certificates already exist in ${certificate_output_directory} (pass --force to regenerate)."
  exit 0
fi

rm -rf "${certificate_output_directory}"
mkdir -p "${certificate_output_directory}"

temporary_working_directory="$(mktemp -d)"
trap 'rm -rf "${temporary_working_directory}"' EXIT

# Random serials instead of -CAcreateserial, so no ca.srl state file is left behind.
generate_random_certificate_serial() {
  echo "0x$(openssl rand -hex 16)"
}

# Test CA.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -set_serial "$(generate_random_certificate_serial)" \
  -subj "/CN=Scratch Local MySQL Test CA" \
  -keyout "${certificate_output_directory}/ca-key.pem" \
  -out "${certificate_output_directory}/ca.pem" 2>/dev/null

# Server certificate signed by the test CA. `-extfile` (not `-addext`/`-copy_extensions`) so macOS's LibreSSL works too.
openssl req -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=localhost" \
  -keyout "${certificate_output_directory}/server-key.pem" \
  -out "${temporary_working_directory}/server.csr" 2>/dev/null
cat >"${temporary_working_directory}/server-certificate-extensions.cnf" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EOF
openssl x509 -req -sha256 -days 825 \
  -in "${temporary_working_directory}/server.csr" \
  -CA "${certificate_output_directory}/ca.pem" \
  -CAkey "${certificate_output_directory}/ca-key.pem" \
  -set_serial "$(generate_random_certificate_serial)" \
  -extfile "${temporary_working_directory}/server-certificate-extensions.cnf" \
  -out "${certificate_output_directory}/server-cert.pem" 2>/dev/null

# An unrelated CA: VERIFY_CA with this one must fail.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -set_serial "$(generate_random_certificate_serial)" \
  -subj "/CN=Scratch Local Unrelated Test CA" \
  -keyout "${temporary_working_directory}/wrong-ca-key.pem" \
  -out "${certificate_output_directory}/wrong-ca.pem" 2>/dev/null

openssl verify -CAfile "${certificate_output_directory}/ca.pem" "${certificate_output_directory}/server-cert.pem" >/dev/null
chmod 644 "${certificate_output_directory}"/*.pem

echo "Wrote test TLS certificates to ${certificate_output_directory}:"
echo "  CA to paste into the connector:  ${certificate_output_directory}/ca.pem"
echo "  Unrelated CA (negative case):    ${certificate_output_directory}/wrong-ca.pem"
