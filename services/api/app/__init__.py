"""Qash API: a thin server.

It stores accounts, passkeys, plans, group % progress, a minimal alert schedule and
ciphertext backups. It never stores statements, receipts or transactions
(docs/spec.md "Data flow"). All money math runs on the device.
"""

API_VERSION = "0.1.0"  # must equal [project].version in pyproject.toml (tested)
