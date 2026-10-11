# Architecture

Status: **draft (Phase 0)**. Numbers referenced here come from [LIMITS.md](LIMITS.md). Decisions and their reasons are in [DECISIONS.md](DECISIONS.md).

## Overview

```
 Telegram ─────────────────────────────────────────────────────────────┐
  ├─ bot "veil" (cloud Bot API, webhook) ── commands, mini app button  │
  ├─ mini app (served by the Worker) ── initData ──┐                   │
  └─ bot "courier" ◄── files (local Bot API server on the runner) ─────┼──┐
                                                    ▼                  │  │
 Cloudflare                                                            │  │
  ├─ Worker (TS, Hono)  auth · REST · webhook · dispatch · cron        │  │
  ├─ Durable Object "Hub" (one instance, SQLite)  WS hub + job pump   │  │
  ├─ D1  users · searches · jobs · tracks · events · suggestions …     │  │
  └─ KV  feed caches (cron-written only)                               │  │
                │ workflow_dispatch (REST)          ▲ outbound WS      │  │
                ▼                                   │                  │  │
 GitHub Actions runner (public repo, concurrency group "veil-runner")  │  │
  ├─ slskd (Soulseek client, REST on localhost)                        │  │
  ├─ telegram-bot-api (local server, localhost)  ──────────────────────┘──┘
  └─ veil-agent (Python) ── drives both, talks to the Hub
```

The runner makes **outbound** connections only, so nothing ever has to reach into it. Commands travel down the runner's own WebSocket to the Hub.

## Components

### Worker (front door)
- **Auth:**
  - Every mini app request carries `initData`. The Worker checks its HMAC as described in [LIMITS.md](LIMITS.md#telegram), rejects it if `auth_date` is older than 24 h, then looks up `user.id` in `users` (must be `status = active`).
  - Bot webhook calls must carry the `X-Telegram-Bot-Api-Secret-Token` header we set during `setWebhook`.
- **Doorbell:** if the Hub reports `offline`, the Worker calls `workflow_dispatch` with `inputs: { session_id }`.
  - It never passes secrets as inputs, because inputs show up on the public run page.
  - It debounces: no new dispatch while the Hub is in `booting`. The workflow's `concurrency:` group is the second guard.
- **CPU budget:** 10 ms per request. Handlers do I/O and small JSON only.

### Durable Object "Hub"
There is a single instance, because there's a single runner.
- Holds the runner's WebSocket and every open mini app WebSocket, using the Hibernation API if the Free plan allows it (⚠ see LIMITS).
- Owns the **session state**: `offline | booting | ready | draining`. It also keeps a heartbeat deadline. If the runner goes quiet for 90 s, state falls back to `offline`.
- **Job pump:** on `runner.hello`, it sends every D1 job in `pending`. New jobs while `ready` are pushed immediately.
- Fans out job progress to the mini app sockets belonging to the job's owner. Progress messages are throttled on the runner side (at most 1 per job every 2 s).

### D1 (text only)
Draft schema. The real migrations land in Phase 2.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | allowlist and prefs | `tg_id` PK, `name`, `role` (admin/member), `status` (pending/active/revoked), `prefs` JSON |
| `searches` | history | `id`, `user_id`, `query`, `format_filter`, `result_count`, `created_at` |
| `jobs` | download queue | `id`, `user_id`, `search_id`, `peer`, `path`, `size`, `format`, `bitrate`, `state`, `attempts`, `error`, `track_id`, timestamps |
| `tracks` | what was delivered | `id`, `artist`, `title`, `album`, `year`, `format`, `mb_recording`, `mb_release` |
| `events` | activity feedback | `user_id`, `type` (search/tap/download/skip/deliver), `ref`, `feed`, `created_at` |
| `suggestions` | Explore items | `user_id`, `feed`, `mbid`, `kind`, `artist`, `title`, `year`, `reason`, `score`, `outcome` |
| `wishlist` | wanted later | `user_id`, `query` or `mbid`, `format_filter`, `status`, `last_checked` |
| `peer_stats` | source reliability | `peer_hash` (HMAC of username), `ok`, `fail`, `refused`, `avg_kbps`, `last_seen` |

**Leaves nothing behind:**
- When a job reaches `delivered`, its `peer` and `path` are set to NULL. They were only needed to re-request after a restart.
- Peer usernames are kept only as HMACs in `peer_stats`.

### KV
- `feed:{user}:{feed}`: precomputed Explore lists, written by cron.
- Nothing per-request or live goes in KV (1,000 writes/day).

### Runner (GitHub Actions)
- **Workflow:** `.github/workflows/runner.yml` with `on: workflow_dispatch` only, plus `concurrency: { group: veil-runner, cancel-in-progress: false }`.
- **Boot order:**
  1. Fetch slskd and telegram-bot-api, using cached binaries/images where possible.
  2. Start both on localhost.
  3. Start the agent, which opens the Hub WS (sends `RUNNER_SECRET` in the header) and sends `runner.hello`.
- **The agent:**
  - Turns `search.start` into slskd searches and streams grouped results back.
  - Turns `job.start` into slskd downloads.
  - When a file is complete, uploads it through the local Bot API (courier bot), then **deletes the file** and sends `job.delivered` with the Telegram message id.
- **Shutdown:** idle for 20 min (configurable), or a hard cap of 5 h 30 m (GitHub kills jobs at 6 h).
  1. Switch to `draining` and finish uploads already in progress.
  2. Report unfinished jobs as `pending`.
  3. Stop slskd gracefully so it logs out of Soulseek.
  4. Send `runner.bye` and exit 0.
- **Pluggable host:** the agent knows nothing about GitHub. Anything that can run `runner/start.sh` with the env vars set works as a host. When we move to a VPS, only the doorbell changes: the Worker would call the VPS instead of `workflow_dispatch`, or the VPS stays always-on.

### Two bots
- **veil** is the front door: it uses the cloud Bot API with a webhook to the Worker.
- **courier** delivers files: it uses the local Bot API server on the runner.

Why two: a bot has to `logOut` from the cloud API before running on a local server, and it can't log back into the cloud for 10 minutes afterwards. Keeping one bot on each side avoids that conflict. Each user taps **Start** on courier once so it's allowed to message them. 🧪 The spike checks whether a single bot could do both. If so, we simplify.

## Format choice

You pick the format per search, with defaults saved in `users.prefs`:

| Pref | Default | Meaning |
|---|---|---|
| `format` | `flac` | `flac` · `mp3` · `any` (segmented toggle on the search screen) |
| `max_mb` | `150` | Files above this are flagged and ranked lower, never hidden. |
| `fallback` | `true` | If no FLAC under `max_mb` exists, rank MP3 320 above oversized FLAC. |

How each format is delivered:
- **MP3/M4A** go through `sendAudio`, so they appear in Telegram's music player.
- **FLAC** goes through `sendDocument`. The Bot API only lists MP3/M4A for `sendAudio`. 🧪 We check how clients display FLAC documents.
- Nothing is ever transcoded.

## Search → delivery flow

1. **Mini app → Worker:** `POST /api/search {q, format}`.
   - The Worker writes a `searches` row.
   - If the Hub is offline, the Worker dispatches the runner. The search waits in the Hub until `ready`.
2. **Hub → runner:** `search.start`. The runner returns `search.results` in batches, grouped by peer and folder, each with size, bitrate, free slot, queue length, and a peer score from `peer_stats` (fetched by the Hub at hello).
3. **Mini app → Worker:** `POST /api/jobs {search_id, peer, path…}` (a single file, or a whole folder for an album).
   - The Worker writes `jobs` rows (`pending`).
   - The Hub pushes them to the runner.
4. **Runner → Hub:** `job.state` updates: `queued(n) → downloading(%) → uploading → delivered | failed(reason)`.
5. **On delivered:** the Worker writes the `tracks` and `events` rows, nulls `peer`/`path`, and updates `peer_stats`.

## Protocol (Hub ↔ runner, Hub ↔ app)

These are our own messages, so we define them; nothing external is being guessed. The canonical source will be a JSON Schema file in `protocol/`, from which TS types and Python models are generated.

Envelope: `{ "v": 1, "type": "<domain>.<verb>", "id": "<uuid>", "ts": <unix ms>, "data": { … } }`

Planned types:
- **Runner:**
  - `runner.hello` / `runner.heartbeat` / `runner.bye`
  - `session.state`
  - `search.start` / `search.results` / `search.done`
  - `job.start` / `job.cancel` / `job.state`
- **App:** `app.subscribe`, `session.state`, `search.results`, `job.state`

The fields are finalized in Phase 3.

## Cron

There are 5 crons per account. This is how they're allocated:

| # | Schedule | Job |
|---|---|---|
| 1 | weekly (Mon 06:00 UTC) | weekly mix |
| 2 | daily | Explore refresh (small batches) + wishlist check |
| 3–5 | spare | |

**Open question for Phase 5:** gathering Explore candidates means many rate-limited MusicBrainz/ListenBrainz calls, and that may not fit the Worker's CPU and subrequest limits (50 per invocation). The fallback is a separate scheduled `explore` workflow on the runner repo (no Soulseek login) that writes candidates back through the Worker. Workers AI ranking stays in the Worker.

## Privacy

- **Public repo logs:** the agent logs only counts and states (e.g. `search done: 143 results`). It never prints queries, filenames, peer names, or Telegram ids. All three binaries run with their stdout piped through a filter or silenced.
- **No secrets as workflow inputs.** Secrets live only in GitHub Secrets and in Worker secrets.
- **Who can trigger the runner:** only `workflow_dispatch`. No `pull_request` triggers, so forks can't run it or reach secrets.
- **Storage:** D1 holds text only. No audio, no cover art (covers are hotlinked from Cover Art Archive by MBID).

## Secrets

| Where | Name | Purpose |
|---|---|---|
| GitHub | `SLSK_USERNAME`, `SLSK_PASSWORD` | Soulseek account |
| GitHub | `COURIER_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH` | Local Bot API server and delivery |
| GitHub + Worker | `RUNNER_SECRET` | Runner ↔ Hub auth |
| Worker | `VEIL_BOT_TOKEN`, `WEBHOOK_SECRET` | Front bot, webhook check |
| Worker | `GH_DISPATCH_TOKEN` | Fine-grained PAT, this repo only, Actions: write (⚠) |
| Worker | `PEER_HMAC_KEY` | Hashing peer names |

## Repo layout (target)

```
veil/
  docs/                 VEIL, ARCHITECTURE, DESIGN, LIMITS, DECISIONS, RUNBOOK
  protocol/             messages.schema.json (+ generated types)
  worker/               Cloudflare Worker + Hub DO + migrations (TS)
  app/                  mini app (Vite + Preact), built into worker assets
  runner/               veil-agent (Python), start.sh
  .github/workflows/    runner.yml, spike.yml
```
