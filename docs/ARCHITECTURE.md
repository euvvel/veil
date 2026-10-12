# Architecture

How veil is built today. Numbers come from [LIMITS.md](LIMITS.md); reasons from [DECISIONS.md](DECISIONS.md); the runner protocol from [protocol/PROTOCOL.md](../protocol/PROTOCOL.md).

## Overview

```
 Telegram
  ├─ bot "veil"     cloud Bot API · webhook → Worker · commands, results, status
  ├─ mini app       served by the Worker · initData auth · live socket via tickets
  └─ bot "courier"  sends files (≤ 50 MB) from the runner; never reads updates
                │                                   ▲ sendAudio / sendDocument
                ▼                                   │
 Cloudflare     Worker (Hono) ── Hub (one Durable Object, SQLite) ── D1 (text only)
                │   auth · API · webhook     session · search routing · job pump
                │                            live state to the app · transient cache
                │ workflow_dispatch                 ▲ outbound WebSocket
                ▼                                   │
 GitHub Actions runner (public repo, concurrency group "veil-runner", ≤ 5 h 30 m)
  ├─ slskd (Docker, localhost)    Soulseek login, search, download
  ├─ veil agent (Python)          drives slskd, talks to the Hub, delivers, deletes
  └─ door + cloudflared           files over 50 MB, behind a named tunnel (D8)
```

The runner makes **outbound** connections only: its WebSocket to the Hub, Telegram, and the tunnel. Nothing reaches into it except through the door's one-time links.

## Components

### Worker (`worker/src/index.ts`)

**Webhook `/tg/webhook`**
- Checked against `X-Telegram-Bot-Api-Secret-Token`.
- Replies are sent with an explicit Bot API call, and every outcome is logged (`{"at":"reply",…}`).
- Strangers get silence: an empty 200, and nothing is sent.

**Mini app API `/api/*`**
- Auth is `Authorization: tma <initData>`:
  - HMAC checked, `auth_date` no older than 24 h.
  - The user is then looked up as `HMAC(MEMBER_HMAC_KEY, user id)` in `members`.
  - Anyone else gets a 404.
- Routes:

| Route | Does |
|---|---|
| `GET /api/me` | Role, preferences, session state |
| `PATCH /api/prefs` | Default format, size limit, MP3 fallback |
| `POST /api/search` | Starts a search |
| `GET /api/search/:sid?view&fmt&offset&count` | Ranked results, paged (≤ 60 per call) |
| `POST /api/cross {sid, index, key}` | Starts a crossing. `key` = name\|size guards against reranking while partial results arrive. |
| `GET /api/crossings` | Active crossings and history |
| `GET /api/direct/:gid`, `POST /api/direct/release` | Direct crossing (D8) |
| `GET /api/recent` | Recent searches |
| `GET /api/help` | The shared help text (`help.ts`) |
| `GET /api/session` | Session state and details |
| `POST /api/session/{wake,sleep}` | Wake or sleep the runner (keeper only) |
| `POST /api/ticket` | Single-use 60 s ticket for the live socket |

**Sockets**
- `/hub/runner`: `Authorization: Bearer RUNNER_SECRET`.
- `/hub/app?t=<ticket>`: the ticket comes from `/api/ticket`. initData never goes in a URL, because Cloudflare logs request URLs.

### Hub (`worker/src/hub.ts`)

One Durable Object instance. It uses the WebSocket Hibernation API, with sockets tagged `runner`, `app` and `m:<member_key>`.

**Session**
- States: `offline → booting → ready → draining`, via the pure state machine `session.ts`.
- Boot timeout: 3 min. Heartbeat grace: 90 s.
- **Doorbell:**
  - `workflow_dispatch` with `return_run_details`.
  - It never dispatches while booting.
  - After the runner leaves with work still waiting, it re-rings automatically, at most twice in a row.

**Searches**
- Held while the runner boots, then sent on hello.
- **Results:**
  - Each `search.results` frame replaces the cached results.
  - Partial frames update the app live. The bot sends one message when the search ends.
  - Ranking (`rank.ts`): format filter and fallback, then free slot, peer reliability (`peer_stats`), queue length and speed. Identical files are deduplicated.
  - Up to 400 items are kept per view. The bot shows 8 per page; the app requests 30.

**Crossings** (one tap = a group of jobs)
- Jobs are written to D1, and job state is relayed to the bot's status message and to the member's sockets.
- A peer error moves the job to another peer with the same file, up to 4 sources in all.
- **On delivery:**
  - A `tracks` row is written from the file's tags.
  - The job's `chat_id`, `peer` and `path` are erased.
  - `peer_stats` is updated under an HMAC of the peer name.
- **Direct crossing (D8, D8a):** files above the courier limit go to `mode=direct`. The runner offers them behind the door, and the Hub hands the one-time link only to the owner.

**Transient storage**

| Key | Holds | Removed |
|---|---|---|
| `s:` `r:` `v:` | Search, raw results, ranked view | After 6 h |
| `g:` `jg:` | Crossings | When finished |
| `dj:` | Direct tokens | When finished |
| `alt:` | Peers already tried | When finished |
| `t:` | Socket tickets | After 60 s |
| `wakers` | Chats waiting for `/wake` | At hello |
| `direct` | This session's tunnel URL | When the runner leaves |

### Runner (`.github/workflows/runner.yml`, `runner/agent/`)

**Boot**
1. Check out the repo, set up Python, install pinned dependencies.
2. Start slskd (pinned by digest) with no shares.
3. If tunnel secrets exist, start cloudflared 2026.9.3 (pinned by checksum) and wait for `/ready`.
4. Start the agent.

Dispatch to Soulseek login takes about 20 s.

**Agent loop**
- **Search:**
  - slskd with `searchTimeout` 15000 (milliseconds; see LIMITS), `responseLimit` 500, `fileLimit` 25,000.
  - Snapshots every 5 s while answers arrive.
  - Each snapshot is grouped by folder and trimmed to ≤ 120 folders × 40 audio files, keeping the best FLAC and MP3 folders.
- **Jobs:**
  - One slskd batch per job, tagged with `externalId`.
  - Polled every 2 s, with progress at most every 2 s. Queue position is refreshed every 30 s.
  - **Done:** tags are read with mutagen, then courier sends the file (`sendAudio` for MP3/M4A, `sendDocument` otherwise) and the file is deleted.
  - **Direct:** the file is offered behind the door instead (30 min, released by the member). The door drops readers stalled for 60 s, and a busy transfer can delay cleanup by at most 10 min.
- **Drain:**
  - Triggered by 20 min idle, the 5 h 30 m cap, or `/sleep`.
  - Finish uploads, hand back unfinished jobs, settle direct files, log out of Soulseek (`DELETE /server`), close the door, say goodbye.
- **Logs** are public, so they hold counts and states only. No queries, names, peers or ids.

## Data (D1, text only)

| Table | Holds |
|---|---|
| `members` | `member_key` (HMAC), role, status, prefs (format, `max_mb`, fallback, menu version) |
| `invites` | Hashed single-use codes, 24 h |
| `searches` | Query, format, result count, time |
| `jobs` | Crossing state, `group_id`, mode, attempts. `chat_id`, `peer` and `path` exist only while in flight. |
| `tracks` | Artist, title, album, year, format, MusicBrainz ids (from tags) |
| `events` | search, download, deliver (feeds Phase 5) |
| `peer_stats` | `peer_hash` (HMAC), ok/fail/refused, average speed |

## Help, in one place

`worker/src/help.ts` holds every command and the guide text. It feeds:
- the bot's `/help`
- the per-chat command menus, which refresh themselves when the command set changes (`MENU_VERSION`)
- the mini app's Guide (`/api/help`)

`test/help.test.ts` fails if [GUIDE.md](GUIDE.md) misses a command.

## Privacy

- **Stored:** text only. No audio, no cover art, no Telegram ids (members are HMACs).
- **In flight only:** peer names, paths and chat ids, erased on delivery.
- **Public repo:** logs carry counts only. Secrets never go in workflow inputs.
- **Hidden values:** the custom domains (app and door) live only in secrets.
- **Worker logs:** contain command names and reply outcomes, never ids or search words. The mini app socket uses single-use tickets, so no login data appears in logged URLs.

## Secrets

| Where | Name | Purpose |
|---|---|---|
| GitHub | `SLSK_USERNAME`, `SLSK_PASSWORD` | Soulseek account |
| GitHub | `COURIER_BOT_TOKEN` | Delivery |
| GitHub | `HUB_URL`, `RUNNER_SECRET` | Runner ↔ Hub |
| GitHub | `TUNNEL_TOKEN`, `DIRECT_BASE` | Door (D8). Optional. |
| Worker | `VEIL_BOT_TOKEN`, `WEBHOOK_SECRET` | Front bot, webhook check |
| Worker | `RUNNER_SECRET`, `GH_DISPATCH_TOKEN` | Runner auth, doorbell (PAT: this repo, Actions write) |
| Worker | `MEMBER_HMAC_KEY`, `PEER_HMAC_KEY`, `CLAIM_SECRET` | Fingerprints and the one-time claim |
| Worker | `APP_URL` | Mini app origin (menu and "Receive it" buttons) |
