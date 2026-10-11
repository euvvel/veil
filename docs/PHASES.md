# Phases

| # | Phase | Status |
|---|---|---|
| 0 | Docs, decisions, limits | ✅ done |
| 1 | Runner spike (riskiest unknowns) | next |
| 2 | Front door: Worker, auth, D1, Hub DO, dispatch, bot webhook | |
| 3 | MVP loop: search → download → deliver, idle shutdown, history | |
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
