# Phases

| # | Phase | Status |
|---|---|---|
| 0 | Docs, decisions, limits | ✅ done |
| 1 | Runner spike (riskiest unknowns) | A ✅ B ✅ · local Bot API pending api_id |
| 2 | Front door: Worker, auth, D1, Hub DO, dispatch, bot webhook | ✅ done (2026-10-12) |
| 3 | MVP loop: search → download → deliver, idle shutdown, history | built, live test pending |
| 4 | Mini app UI (Seek, Crossings, status bar) | |
| 5 | Beyond (Explore feeds, weekly mix, feedback) | |
| 6 | Wishlist, invites, AI query rewrite and filename cleanup | |

## Phase 1: runner spike

**Goal:** measure what can't be checked from docs, before building on top of it. The output is a numbers-only report. Nothing identifying goes into the public logs.

`spike.yml` (workflow_dispatch, input: `query_set` = an index into a list held in a secret, so no query text appears in logs):

1. Start slskd (download dir under `$RUNNER_TEMP`, no shares, listen port set) and wait for login.
2. Dump `/swagger` JSON to a job **artifact**, not the log, so we work from the real REST shapes. ⚠ The artifact is public too in a public repo. It holds no secrets, so that's acceptable.
3. Run 3 searches and record result counts, the count of free-slot results, and time to first result.
4. Try up to 10 downloads (a mix of small MP3 and >50 MB FLAC). Record success, failure (and the reason category), and throughput.
5. Start `telegram-bot-api` and record its boot time. Send one MP3 with `sendAudio` and one FLAC over 50 MB with `sendDocument` through courier, to the admin's chat.
6. Delete the files, stop slskd gracefully, and confirm the logout.

**Questions it answers:**

| Question | Decides |
|---|---|
| Boot → ready time | "booting" UX and idle timeout |
| Download success rate without inbound ports | Whether F3 mitigation (relay VPS) is needed early |
| Is the Soulseek server OK with Azure IPs? | Viability of GitHub Actions as host |
| How courier's FLAC document looks in clients | D5 delivery |
| Single bot on cloud + local at once? | Whether D3 can be simplified |
| Real slskd REST shapes | Phase 3 agent code |

### Results (2026-10-11)
- **Stage A (run 38167125143):** slskd pull 7 s, API ready 2 s. telegram-bot-api builds in 12.5 min, then comes from cache. 4 vCPU, 15 GB.
- **Stage B (run 38170474457):**
  - Login works from GitHub IPs, about 22 s from dispatch.
  - Searches return 220–250 peers.
  - 7 of 8 downloads succeeded with no inbound port.
  - MP3 and FLAC were both delivered, and logout was clean.
- **Conclusion:** the GitHub runner is viable. "Booting" is ~20–30 s, not minutes. F3 (no inbound connections) isn't blocking, so we skip the relay VPS.
- **Remaining:** start the local Bot API server and send a file over 50 MB (needs TG_API_ID/HASH). Test peers without a free slot.

## Phase 2: results (2026-10-12)
- **Tests:** 15 unit tests (initData, session state machine) and 25 local end-to-end checks against `wrangler dev`, in `worker/test/local-smoke.mjs`.
- **Live test:**
  - The owner claimed the admin role.
  - `/wake` started the runner: dispatch, GitHub run, and runner hello in **14 s**.
  - Hub state went ready, with heartbeats every 30 s, then a clean goodbye back to offline.
- **Hibernation (U1):** `ctx.acceptWebSocket` works on the Free plan. Whether the DO actually sleeps isn't visible yet; we'll check duration usage in the dashboard.
- **Deployment notes:**
  - The account's `*.workers.dev` subdomain answers 1101 for every Worker, even a hello world.
  - veil is served on a custom domain, attached through the API and kept out of the repo. It's held in `HUB_URL` (GitHub secret) and the webhook URL.
