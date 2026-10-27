#!/usr/bin/env bash
# Generates the TEST-ONLY TLS files for the opt-in `postgres-tls` service in ../docker-compose.postgres-tls.yml
# (DEV-12575), into ./certs (gitignored):
#   ca.pem / ca-key.pem                 a throwaway CA. Paste ca.pem into the connector's Server CA certificate field.
#   server-cert.pem / server-key.pem    signed by that CA, named DNS:localhost only (no IP address), so verify-full
#                                       passes for host `localhost` and fails for `127.0.0.1`, while verify-ca passes
#                                       for both. That's the Cloud SQL case: its certificate doesn't name the IP.
#   client-cert.pem / client-key.pem    a client certificate signed by the CA, for the user that must present one
#   wrong-ca.pem                        an unrelated CA, for the "verify-ca with the wrong CA" case
#   untrusted-client-cert.pem / untrusted-client-key.pem
#                                       a client certificate signed by the unrelated CA, which the server refuses
# The keys protect nothing — never reuse them anywhere.
#
# Usage: server/localdev/postgres-tls/generate-tls-certs.sh [--force]
#   Skips when the certificates already exist. --force regenerates them; then recreate the container so Postgres loads
#   the new ones: docker compose -f docker-compose.postgres-tls.yml up -d --force-recreate --wait
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
certificate_output_directory="${script_directory}/certs"

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

# A CA: generate_certificate_authority <common name> <key file> <certificate file>
generate_certificate_authority() {
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -set_serial "$(generate_random_certificate_serial)" \
    -subj "/CN=$1" \
    -keyout "$2" \
    -out "$3" 2>/dev/null
}

# A certificate signed by a CA:
#   generate_signed_certificate <common name> <extensions> <CA certificate> <CA key> <key file> <certificate file>
# `-extfile` (not `-addext`/`-copy_extensions`) so macOS's LibreSSL works too.
generate_signed_certificate() {
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=$1" \
    -keyout "$5" \
    -out "${temporary_working_directory}/request.csr" 2>/dev/null
  printf '%s\n' "$2" >"${temporary_working_directory}/extensions.cnf"
  openssl x509 -req -sha256 -days 825 \
    -in "${temporary_working_directory}/request.csr" \
    -CA "$3" \
    -CAkey "$4" \
    -set_serial "$(generate_random_certificate_serial)" \
    -extfile "${temporary_working_directory}/extensions.cnf" \
    -out "$6" 2>/dev/null
}

generate_certificate_authority "Scratch Local Postgres Test CA" \
  "${certificate_output_directory}/ca-key.pem" "${certificate_output_directory}/ca.pem"
generate_certificate_authority "Scratch Local Unrelated Test CA" \
  "${temporary_working_directory}/wrong-ca-key.pem" "${certificate_output_directory}/wrong-ca.pem"

server_certificate_extensions='basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost'
client_certificate_extensions='basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth'

generate_signed_certificate "localhost" "${server_certificate_extensions}" \
  "${certificate_output_directory}/ca.pem" "${certificate_output_directory}/ca-key.pem" \
  "${certificate_output_directory}/server-key.pem" "${certificate_output_directory}/server-cert.pem"
generate_signed_certificate "scratch_tls_cert_user" "${client_certificate_extensions}" \
  "${certificate_output_directory}/ca.pem" "${certificate_output_directory}/ca-key.pem" \
  "${certificate_output_directory}/client-key.pem" "${certificate_output_directory}/client-cert.pem"
generate_signed_certificate "scratch_tls_cert_user" "${client_certificate_extensions}" \
  "${certificate_output_directory}/wrong-ca.pem" "${temporary_working_directory}/wrong-ca-key.pem" \
  "${certificate_output_directory}/untrusted-client-key.pem" "${certificate_output_directory}/untrusted-client-cert.pem"

openssl verify -CAfile "${certificate_output_directory}/ca.pem" \
  "${certificate_output_directory}/server-cert.pem" "${certificate_output_directory}/client-cert.pem" >/dev/null
# The container copies the server key and sets its own permissions (Postgres refuses a key others can read).
chmod 644 "${certificate_output_directory}"/*.pem

echo "Wrote test TLS certificates to ${certificate_output_directory}:"
echo "  CA to paste into the connector:        ${certificate_output_directory}/ca.pem"
echo "  Client certificate and key to paste:   ${certificate_output_directory}/client-cert.pem, client-key.pem"
echo "  Unrelated CA (negative case):          ${certificate_output_directory}/wrong-ca.pem"
