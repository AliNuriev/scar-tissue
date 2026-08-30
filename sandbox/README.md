# sandbox/

The target codebase the pipeline reads, patches and tests against.

Two things live here:

| Path | What it is | Committed? |
|---|---|---|
| `routes/`, `services/`, `tests/` | Small hand-written fixtures used by `engine/backtest` | yes |
| `galaxium-travels/` | The IBM demo app, cloned by `setup.sh` | **no** — gitignored |

---

## Galaxium Travels

[IBM/galaxium-travels](https://github.com/IBM/galaxium-travels) — the demo application from the
hackathon guide. A multi-service interplanetary booking system: Python/FastAPI backend, React/Vite
frontend, and an optional Java/Spring Boot hold service.

### Why it is not committed

The upstream licence is **Apache-2.0**, which *does* permit redistribution — so vendoring it would
be legal. We clone it instead for three reasons:

1. **Licence hygiene.** This repository's `LICENSE` is MIT and states it covers the repository.
   Dropping an Apache-2.0 tree inside it makes that statement false. Honouring Apache-2.0 properly
   would mean carrying the upstream `LICENSE` and `NOTICE`, and marking every modified file — real
   obligations that are easy to get wrong in a public repo that judges will read.
2. **It is the target, not our work.** The pipeline's claim is that it fixes *someone else's*
   codebase. A pristine upstream clone at a known SHA makes that verifiable; a vendored copy we may
   have touched does not.
3. **Size.** The tree plus `node_modules/` and `.venv/` is far larger than everything else here.

If we later decide to vendor it anyway, the correct way is: copy the tree, keep upstream `LICENSE`
at `sandbox/galaxium-travels/LICENSE`, add a `NOTICE`, and amend the root `README` to say the
subdirectory is Apache-2.0. Say the word and I'll do that instead.

### Setup

```bash
./sandbox/setup.sh
```

Clones the app, creates the backend virtualenv, installs Python and npm dependencies. Idempotent —
re-run it to update. Flags: `--skip-frontend`, `--skip-backend`.

**Prerequisites:** Node.js 18+, Python 3.8+, git. Java 17/21 + Maven only if you want the hold
service, which we do not use.

### Running

Two terminals:

```bash
# terminal 1 — backend, http://localhost:8001
cd sandbox/galaxium-travels/booking_system_backend
./.venv/Scripts/python.exe server.py     # Windows
./.venv/bin/python server.py             # macOS / Linux
```

```bash
# terminal 2 — frontend, http://localhost:5173
cd sandbox/galaxium-travels/booking_system_frontend
npm run dev
```

The backend seeds a SQLite database with demo data on first start (10 travellers, 10 routes,
20 bookings). No configuration or API key is required — it runs fully offline.

> **`npm run dev`, not `npm start`.** Upstream `package.json` defines `dev`, `build`, `lint` and
> `preview`. There is no `start` script.

### Verifying it works

```bash
curl http://localhost:8001/flights        # JSON array of 10 routes
open http://localhost:8001/docs           # Swagger UI
open http://localhost:5173                # the app
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/flights` | List routes with per-class seat availability and pricing |
| POST | `/book` | Create a booking |
| GET | `/bookings/{user_id}` | Bookings for a traveller |
| POST | `/cancel/{booking_id}` | Cancel a booking |
| POST | `/register`, GET `/user` | Traveller management |
| POST | `/quotes`, `/quotes/{id}/holds` | Quote & hold workflow (proxies the Java service) |
| POST | `/holds/{id}/confirm`, `/holds/{id}/release` | Hold lifecycle |

Swagger UI at `/docs`, MCP endpoint at `/mcp`.

### Ports

| Service | Port |
|---|---|
| Backend REST + MCP | 8001 |
| Frontend | 5173 |
| Java hold service (unused) | 8080 |

### Notes and gotchas

- **Windows long paths.** The Java service has paths over the 260-character `MAX_PATH` limit;
  a plain `git clone` fails checkout partway with `Filename too long`. `setup.sh` passes
  `-c core.longpaths=true` to avoid this. If you cloned by hand and hit it, re-clone with that flag.
- **OneDrive.** This repo sits under OneDrive on at least one machine. `node_modules/` and `.venv/`
  are gitignored but OneDrive still syncs them, which is slow and can lock files mid-install. If
  installs fail oddly, pause syncing first.
- **Hold endpoints need Java.** `/quotes` and `/holds/*` proxy to the Spring Boot service on 8080.
  Without it those five endpoints error; everything else works. We don't need them.
