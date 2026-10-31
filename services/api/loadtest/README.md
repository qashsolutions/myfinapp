# Load test

What many people with Qash open cost the API. Never pointed at production: `seed.py` refuses any
database but `stackd_load`, and `start-api.sh` runs a local API on port 8200 against it, with its
own bucket (`stackd-load`).

- `seed.py N`: N accounts, each an unlocked session with a passkey, the Connected plan, a backup
  key and a place in a challenge of five. Tokens go to `.output/tokens.txt` (gitignored).
- `locustfile.py`: one simulated person = one device with the app open. On open it reads what
  AppShell and the first screens read; then a screen change every 15–45 s, the backup sync every
  5 minutes (an upload half the time, 64 KB of ciphertext), and for one person in ten the
  household check every 2 minutes. Calls the app makes on its own carry `X-Qash-Background`.
  `LOAD_WAIT="0 0"` sends back to back, to find what one server can do.
- `per_endpoint.py N`: CPU milliseconds per request, endpoint by endpoint.
- `profile_api.py`: the API under yappi (`LOAD_PROFILE=1 loadtest/start-api.sh`).

```bash
createdb -O stackd stackd_load                       # once
STACKD_DATABASE_URL=…/stackd_load uv run stackd-api migrate
STACKD_DATABASE_URL=…/stackd_load uv run python loadtest/seed.py 10000
loadtest/start-api.sh                                 # one process, as the Dockerfile runs it
cd loadtest && uv run --with locust locust -f locustfile.py --host http://127.0.0.1:8200 \
  --headless -u 2000 -r 20 -t 7m --only-summary
uv run --with httpx python loadtest/per_endpoint.py 1500
```

## Results, October 31, 2026 (one process on an Apple M5, local Postgres)

A person with the app open sends one request about every 25 seconds (0.039 a second).

| | Before | After this round |
|---|---|---|
| 200 requests at once | Stalled: idle, then 500s after 30 s (pool exhausted) | 407 a second, no errors |
| Signed-in check | 3 queries | 1 query |
| Alert schedule, 300 items | 903 queries | 33 |
| Plan screen's Founding count | read every subscription | reads Founding rows only |
| CPU per request, the app's mix | 4.7 ms | 3.3 ms |

| People with the app open | Requests a second | Median | 95th percentile | Errors |
|---|---|---|---|---|
| 2,000 (steady) | 78 | 6 ms | 13 ms | 0 |
| 10,000 (steady, one process) | ~310 served of ~390 asked | ~8 s | ~8 s | 2% `busy` while arriving |

One process here serves about 330–400 requests a second. Production's API container is far
smaller (Micro: a quarter of a vCPU, shared with the jobs container), so these numbers are an
upper bound for it, not a measurement of it.
