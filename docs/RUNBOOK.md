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
1. Phase 2: `wrangler login`, create the D1 database and KV namespace, then set the Worker secrets listed in [ARCHITECTURE.md](ARCHITECTURE.md#secrets).

## Access
1. Claim: open `t.me/<veil_bot>?start=<claim code>` once. You become admin. The claim code stops working once a member exists.
2. Invite: send `/invite` to veil to get a single-use link valid for 24 h, and share it.
3. Revoke: `/members`, then pick a member to revoke.

## If the GitHub account is banned
Point the doorbell at another host (see D1 in [DECISIONS.md](DECISIONS.md)). The Worker, D1, and the mini app don't change.
