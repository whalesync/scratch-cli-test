"""AES-256-GCM encryption, compatible with the NestJS EncryptionService.

Format: {encrypted: hex(ciphertext + auth_tag), iv: hex, salt: hex}
Key derivation: scrypt(master_key, salt, key_length=32)
AAD: b"connector-account"

To remove: delete this file. Nothing else imports it except app/routes/oauth.py.
"""

from __future__ import annotations

import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


def _derive_key(master_key: str, salt: bytes) -> bytes:
    kdf = Scrypt(salt=salt, length=32, n=16384, r=8, p=1)
    return kdf.derive(master_key.encode())


def encrypt(plaintext: str, master_key: str) -> dict:
    """Encrypt a string. Returns {encrypted, iv, salt} (all hex)."""
    if not plaintext:
        return {"encrypted": "", "iv": "", "salt": ""}

    salt = os.urandom(32)
    iv = os.urandom(16)  # AES-GCM uses 12-byte nonce typically, but NestJS uses 16
    key = _derive_key(master_key, salt)

    aesgcm = AESGCM(key)
    # NestJS uses 16-byte IV and AAD = "connector-account"
    ct_and_tag = aesgcm.encrypt(iv, plaintext.encode(), b"connector-account")
    # cryptography lib returns ciphertext + 16-byte tag concatenated

    return {
        "encrypted": ct_and_tag.hex(),
        "iv": iv.hex(),
        "salt": salt.hex(),
    }


def decrypt(data: dict, master_key: str) -> str:
    """Decrypt {encrypted, iv, salt} (all hex). Returns plaintext string."""
    encrypted_hex = data.get("encrypted", "")
    iv_hex = data.get("iv", "")
    salt_hex = data.get("salt", "")

    if not encrypted_hex or not iv_hex or not salt_hex:
        return ""

    salt = bytes.fromhex(salt_hex)
    iv = bytes.fromhex(iv_hex)
    ct_and_tag = bytes.fromhex(encrypted_hex)
    key = _derive_key(master_key, salt)

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ct_and_tag, b"connector-account")
    return plaintext.decode()


def encrypt_obj(obj: dict, master_key: str) -> dict:
    return encrypt(json.dumps(obj), master_key)


def decrypt_obj(data: dict, master_key: str) -> dict:
    text = decrypt(data, master_key)
    return json.loads(text) if text else {}
