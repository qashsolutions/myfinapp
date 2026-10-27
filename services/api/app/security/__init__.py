"""Security baseline (chunk 0.5). Every router uses these; none re-implements them.

authz       ownership checks: a row that belongs to someone else looks like it does not exist
step_up     fresh passkey check before export, delete, email change, plan change, bank link
rate_limit  per-route abuse limits counted in Postgres
audit       audit_log writer with a closed set of actions and pseudonymous IPs
headers     response headers (no-store, nosniff, CSP, HSTS in prod)
outbound    HTTP client that refuses hosts outside tools/network_allowlist.txt
hashing     keyed pseudonyms for IPs and rate-limit keys
"""
