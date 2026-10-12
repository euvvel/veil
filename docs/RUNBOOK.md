# Runbook

Status: **draft**. The steps get filled in as each phase lands. Anything marked ⚠ is unverified.

## One-time setup

### Telegram
1. Create two bots with @BotFather: **veil** (front door) and **courier** (delivery). Keep both tokens.
2. On my.telegram.org → API development tools, create an app and note `api_id` and `api_hash`. The local Bot API server needs these.
3. Each user (you and your friend) opens **courier** and taps Start. A bot can't message someone who never started it.
4. Phase 4: register the mini app URL on **veil** with BotFather (`/newapp` or a menu button).

### Soulseek
1. Create a Soulseek account just for veil. Don't reuse a personal one.

### GitHub (second account)
1. Create a **public** repo for veil.
2. Add Actions secrets: `SLSK_USERNAME`, `SLSK_PASSWORD`, `COURIER_BOT_TOKEN`, `TG_API_ID`, `TG_API_HASH`, `RUNNER_SECRET`.
3. Create a fine-grained PAT limited to this repo with **Actions: write** (⚠ confirm that this is the permission dispatch needs). It becomes the Worker's `GH_DISPATCH_TOKEN`.
4. Settings → Actions → General: set "Fork pull request workflows" to require approval, and don't add `pull_request` triggers.

### Cloudflare
1. `wrangler d1 create veil`, put the id in `worker/wrangler.jsonc`, then `wrangler d1 migrations apply veil --remote`.
2. Build the mini app first (`cd app && npm run build`, which writes `worker/public/`), then `wrangler deploy`, then `wrangler secret bulk <json>` with the Worker secrets listed in [ARCHITECTURE.md](ARCHITECTURE.md#secrets).
3. **Custom domain:** workers.dev doesn't serve on this account. Attach a hostname with `PUT /accounts/{id}/workers/domains` (`hostname`, `service: "veil"`, `zone_id`, `environment: "production"`). The hostname stays out of the repo, and a `wrangler deploy` keeps it attached.
4. Set the bot webhook: `setWebhook` with `url=<domain>/tg/webhook`, `secret_token=WEBHOOK_SECRET`, `allowed_updates=["message","callback_query"]`. Clear the public menu with `deleteMyCommands`, `setMyDescription ""` and `setMyShortDescription ""`.
5. GitHub secrets for the runner: `HUB_URL=<domain>`, `RUNNER_SECRET`.
6. Worker secret `APP_URL=https://<domain>` enables the mini app menu button and the "Receive it" button.
7. Direct crossing (D8):
   - Create a named tunnel `veil-door` with ingress `<door host>` → `http://127.0.0.1:8090`, and a proxied CNAME `<door host>` → `<tunnel id>.cfargotunnel.com`.
   - GitHub secrets: `TUNNEL_TOKEN`, `DIRECT_BASE=https://<door host>`. Without them, direct crossing is off and oversize files are refused.

## Access
1. Claim: open `t.me/<veil_bot>?start=<claim code>` once. You become admin. The claim code stops working once a member exists.
2. Invite: send `/invite` to veil to get a single-use link valid for 24 h, and share it.
3. Revoke: `/members`, then pick a member to revoke.

## If the GitHub account is banned
Point the doorbell at another host (see D1 in [DECISIONS.md](DECISIONS.md)). The Worker, D1, and the mini app don't change.

## Reading Worker logs
Each update logs `{"at":"update", kind, cmd|op}` and each reply logs `{"at":"reply", method, ok, error?}`. These never contain ids or search words.

Query them with `POST /accounts/{id}/workers/observability/telemetry/query`:
```json
{ "queryId": "x", "view": "events", "limit": 300,
  "timeframe": { "from": <ms>, "to": <ms> },
  "parameters": { "filters": [{ "key": "$metadata.service", "operation": "eq", "type": "string", "value": "veil" }] } }
```
The console output is in each event's `source` field.

## Deploying a change

1. **Unit tests:** `cd worker && npm test`. This covers initData, the session machine, ranking and paging, and help vs GUIDE.md.
2. **Typecheck:** `cd app && npx tsc --noEmit` and `cd worker && npx tsc --noEmit`.
3. **End-to-end tests** against a fresh local Worker:
   ```sh
   cd worker && rm -rf .wrangler/state && npx wrangler d1 migrations apply veil --local
   npx wrangler dev --port 8787 &          # .dev.vars holds test secrets and REPLY_MODE=webhook;
                                           # CLOUDFLARE_API_TOKEN/ACCOUNT_ID must be set: the AI binding is remote even in dev
   node --experimental-strip-types test/local-smoke.mjs  http://127.0.0.1:8787   # front door, auth, Hub
   node --experimental-strip-types test/phase3-smoke.mjs http://127.0.0.1:8787   # search, paging, crossings
   node --experimental-strip-types test/phase4-smoke.mjs http://127.0.0.1:8787   # app API, direct crossing, fallback
   npm run test:ui -- http://127.0.0.1:8787 [shots-dir]                          # built app in Chrome, inside Telegram's real SDK
   node --experimental-strip-types test/beyond-smoke.mjs http://127.0.0.1:8787   # Beyond against the real ListenBrainz/MusicBrainz (~3 min)
   ```
   The UI test loads `telegram.org/js/telegram-web-app.js` for real, because a permissive stand-in hid an SDK exception that froze the app (the main button refuses empty text). Build the app first; `CHROME_PATH` defaults to `/usr/bin/google-chrome`.
   Each suite needs a fresh D1 (it claims the keeper).
4. **Build the app:** `cd app && npm run build`, which writes `worker/public/`.
5. **Migrate and deploy:** `cd worker && npx wrangler d1 migrations apply veil --remote && npx wrangler deploy`.
6. **Push.** The runner checks out `main` each time it starts, so agent changes take effect on the next wake.

Member command menus refresh themselves after a deploy that changes `help.ts` (`MENU_VERSION`).

## Diagnosing search against real Soulseek
Dispatch the `check-search` workflow. It runs the agent's own search code on a GitHub runner and logs counts only.
- `script=search` prints per query: time, peers, files, folders sent, end state.
- `script=timeline` prints the answer count every second for 30 s.

Queries come from the `SPIKE_QUERIES` secret.

## Client errors
The mini app reports render errors and unhandled exceptions as `{"at":"client", where, message, stack}`, with digits masked. Find them with the observability query above.
