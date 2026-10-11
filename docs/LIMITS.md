# Limits

Every external limit veil depends on, with its source and the date it was checked. If a number here isn't marked ✅, treat it as unknown. Don't design around it until it has been checked.

Legend: ✅ confirmed from official docs · ⚠ unverified, check before relying on it · 🧪 to be measured in the Phase 1 spike

## Cloudflare (Workers Free plan)

| Item | Limit | Status | Source (checked 2026-10-11) |
|---|---|---|---|
| Worker requests | 100,000 / day (resets 00:00 UTC) | ✅ | developers.cloudflare.com/workers/platform/limits |
| Worker CPU time | 10 ms per HTTP request and per cron run | ✅ | same |
| Subrequests | 50 per invocation | ✅ | same |
| Cron Triggers | 5 per account | ✅ | same |
| Static assets | 20,000 files / version, 25 MiB per file | ✅ | same |
| KV reads | 100,000 / day | ✅ | developers.cloudflare.com/kv/platform/limits |
| KV writes | **1,000 / day**, 1 write/s to the same key | ✅ | same |
| KV storage / value size | 1 GB / 25 MiB | ✅ | same |
| D1 rows read | 5,000,000 / day | ✅ | developers.cloudflare.com/d1/platform/pricing |
| D1 rows written | 100,000 / day | ✅ | same |
| D1 size | 500 MB per DB, 10 DBs, 5 GB per account | ✅ | developers.cloudflare.com/d1/platform/limits |
| Durable Objects on Free | Yes, **SQLite-backed only** | ✅ | developers.cloudflare.com/durable-objects/platform/pricing |
| DO requests | 100,000 / day; incoming WS messages billed 20:1; outgoing messages free | ✅ | same |
| DO duration | 13,000 GB-s / day | ✅ | same |
| DO WebSocket Hibernation on Free | not stated | ⚠ | check the DO WebSocket Hibernation API page |
| Workers AI | 10,000 Neurons / day, no paid overage on Free | ✅ | developers.cloudflare.com/workers-ai/platform/pricing |

**What this means for the design**
- **10 ms of CPU per request is tight.** The Worker must not parse large payloads or crunch recommendations inside a request. Heavy work goes in cron runs, which have the same 10 ms budget, so even those must be split into small batches. The Durable Object handles live status. 🧪 Measure Explore precompute against this limit in Phase 5.
- **1,000 KV writes/day:** KV holds only cron-written feed caches and a little session state. Live status never touches KV.
- **5 crons in total:** they're allocated in [ARCHITECTURE.md](ARCHITECTURE.md#cron).

## GitHub Actions

| Item | Limit | Status | Source (checked 2026-10-11) |
|---|---|---|---|
| Cost for public repo + standard runner | free | ✅ | docs.github.com/en/billing/concepts/product-billing/github-actions |
| Private repo minutes (Free) | 2,000 / month | ✅ | same |
| Job execution time | 6 h, after which the job is killed | ✅ | docs.github.com/en/actions/reference/limits |
| Concurrent jobs (Free) | 20 | ✅ | same |
| `workflow_dispatch` REST | `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`, body `ref` + `inputs` (max 25), docs show 200 with `workflow_run_id`, `run_url`, `html_url`. **Observed live 2026-10-11: `204`, no body**, so the run ID may need an opt-in body field. Until confirmed, find the run with `GET /repos/{o}/{r}/actions/runs?event=workflow_dispatch` | ✅ live (204) / ⚠ run-ID opt-in | docs.github.com/en/rest/actions/workflows |
| Fine-grained PAT: create repo, push, push workflows, dispatch | Administration, Contents, Workflows, Actions: write all succeeded with the setup token | ✅ live | 2026-10-11 |
| Inbound connections to the runner | none (NAT) | 🧪 | measure firewalled-peer success rate |
| Runner hardware (ubuntu-latest, public repo) | 4 vCPU, 15 GB RAM | ✅ live | spike-boot run 38167125143, 2026-10-11 |
| slskd image pull + API ready | 7 s + 2 s | ✅ live | same |
| telegram-bot-api build from source | **749 s (~12.5 min)**, 44 MB binary. Cached afterwards | ✅ live | same |
| Actions cache eviction | caches not used for 7 days are evicted, so a gap of a week means a 12.5-min rebuild | ⚠ check docs.github.com dependency-caching limits. Plan: store the binary as a GitHub Release asset instead | |
| Runner boot → slskd logged in | not yet measured (needs credentials) | 🧪 | |

**Public repo means public logs.** The runner must never print queries, filenames, usernames, or peer names. See [ARCHITECTURE.md](ARCHITECTURE.md#privacy).

## Telegram

| Item | Limit | Status | Source (checked 2026-10-11) |
|---|---|---|---|
| Cloud Bot API upload (sendDocument/sendAudio) | 50 MB | ✅ | core.telegram.org/bots/api ("Sending files") |
| Cloud Bot API download (getFile) | 20 MB | ✅ | same |
| Local Bot API server upload | 2,000 MB | ✅ | same ("Using a Local Bot API Server") |
| `sendAudio` formats for the music player | **MP3 or M4A only** | ✅ | same |
| FLAC delivery | send with `sendDocument`; test whether clients show a player | 🧪 | |
| initData validation | HMAC-SHA256: `secret = HMAC(key="WebAppData", msg=bot_token)`; `hash = hex(HMAC(secret, data_check_string))`; fields sorted alphabetically, joined by `\n` | ✅ | core.telegram.org/bots/webapps |
| `hash` excluded from data-check-string | assumed (standard practice); docs wording ambiguous | ⚠ | confirm with a unit test against a real initData |
| auth_date max age | not specified, so we choose (24 h) | ✅ (our policy) | |

## slskd

| Item | Value | Status | Source (checked 2026-10-11) |
|---|---|---|---|
| Credentials | `SLSKD_SLSK_USERNAME`, `SLSKD_SLSK_PASSWORD` | ✅ | github.com/slskd/slskd/blob/master/docs/config.md |
| API key | `SLSKD_API_KEY` (primary key, Administrator role) | ✅ | same |
| Downloads dir | `SLSKD_DOWNLOADS_DIR` (must exist, writable) | ✅ | same |
| Listen port | `SLSKD_SLSK_LISTEN_PORT` | ✅ | same |
| No shares | leave `SLSKD_SHARED_DIR` unset; `SLSKD_SLSK_NO_DNET` allowed when sharing nothing | ✅ | same |
| REST API (v0.26.1) | Auth header `X-API-Key`. Spec at `/swagger/v0/swagger.json` (needs `SLSKD_SWAGGER=true`). `POST /api/v0/searches` (`SearchRequest`: searchText, searchTimeout, filterResponses, maximumPeerQueueLength, minimumPeerUploadSpeed, responseLimit, fileLimit…), `GET /api/v0/searches/{id}/responses`, `POST /api/v0/transfers/downloads/{username}` (array of `QueueDownloadRequest`), `POST /api/v0/transfers/downloads/batches` (has `externalId`), `GET /api/v0/transfers/downloads/{username}/{id}` (+`/position`), `DELETE /api/v0/server` (disconnect). TransferStates: None, Requested, Queued, Initializing, InProgress, Completed, Succeeded, Cancelled, TimedOut, Errored, Rejected, Aborted, Locally, Remotely. | ✅ | full spec saved in `runner/reference/slskd-0.26.1-openapi.json` (pulled from a local run, 2026-10-11) |
| Docker image | `slskd/slskd`, pinned by digest. API ready ~1 s after start locally (no login) | ✅ | local run |

## MusicBrainz / ListenBrainz

| Item | Value | Status |
|---|---|---|
| MusicBrainz rate limit | ~1 req/s per IP, meaningful User-Agent required | ⚠ check musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting |
| ListenBrainz similar-artists / popularity endpoints | exist (labs API), exact shape unknown | ⚠ check listenbrainz.readthedocs.io before Phase 5 |
| Cover Art Archive hotlinking by release MBID | allowed | ⚠ check coverartarchive.org docs |
