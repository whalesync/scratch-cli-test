#!/bin/bash
set -euo pipefail

# First argument is the environment, second is the secret name, third is the secret value
if [ $# -ne 3 ]; then
    echo "usage: $0 <environment> <secret_name> <secret_value>"
    exit 1
fi

env="$1"
name="$2"
value="$3"
secrets_file=$(realpath "$(dirname "$0")/../secrets.txt")
project_id="spv1eu-$env"

# Check if the secret name exists in the secrets file (tolerate CRLF line endings)
if ! grep -qE "^${name}"$'\r'"?$" "$secrets_file"; then
    echo "Error: Secret '$name' not found in $secrets_file"
    exit 1
fi

# Get the current value of the secret, don't fail if it's missing
current_value=$(gcloud secrets versions access latest --secret="$name" --project="$project_id" 2>/dev/null || echo "")

# If the current value is empty, print a message
if [ -z "$current_value" ]; then
    echo "No existing value found for secret '$name'"
else
    echo "Current value for secret $name = $current_value"
    if [[ "$current_value" == "$value" ]]; then
        echo "Secret value is unchanged, nothing to do!"
        exit 0;
    fi
fi

echo "New value for secret $name = $value"

# Confirm before updating the secret
read -p "Are you sure you want to update the secret? [y/N] " -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Update cancelled."
    exit 0
fi

echo -n "$value" | gcloud secrets versions add "$name" --data-file=- --project="$project_id"