# veil

> *Oh could I raise the darken'd veil…* (Nathaniel Hawthorne)

A private Soulseek client you use from Telegram. Seek in a mini app or just type in the chat. The track crosses into your Telegram chat, untouched, and **nothing is kept**: no audio, no Telegram ids, only a line of text that something crossed.

Invite-only, built for a handful of people.

## What it does

- **Seek** from the bot (type words, or `/seek`) or the mini app.
  - Results stream in while Soulseek answers.
  - Ranked by free upload slot, past reliability, queue and speed.
  - Paged (8 per page in the bot, 30 at a time in the app), with FLAC · MP3 · Any and Tracks · Albums.
- **Cross:** the runner downloads, and a separate courier bot delivers the file into your chat. The runner then deletes it.
  - A refusing peer is replaced by another with the same file, up to three times.
  - Files over 50 MB wait at the veil's edge for you to save to your device.
- **Leave nothing behind:**
  - The runner exists only while needed. It wakes on demand and logs out of Soulseek after 20 quiet minutes.
  - Peer names, paths and chat ids exist only while a file crosses.

Using veil: [docs/GUIDE.md](docs/GUIDE.md), which is the same text as the bot's `/help`.

## How it works

```
 Telegram ── bot "veil" (webhook) ─┐        ┌── bot "courier" ◀── files ──┐
          └─ mini app ─────────────┤        │                             │
                                   ▼        │                             │
 Cloudflare  Worker (auth, API) ── Hub (Durable Object: session, routing, live state) ── D1 (text history)
                                   │  ▲ outbound WebSocket                │
                     workflow_dispatch│                                   │
                                   ▼  │                                   │
 GitHub Actions runner:  slskd (Soulseek)  ·  veil agent  ·  door (named tunnel, files > 50 MB)
```

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker and the Hub Durable Object (TypeScript, Hono). D1 migrations. Tests. |
| `app/` | The mini app (Vite + Preact). Builds into `worker/public/`. |
| `runner/agent/` | The runner agent (Python): slskd client, Hub link, courier, door. |
| `.github/workflows/runner.yml` | The runner the Worker starts on demand. |
| `protocol/PROTOCOL.md` | Hub ↔ runner messages. |
| `docs/` | Everything below. |

## Docs

| Doc | For |
|---|---|
| [GUIDE.md](docs/GUIDE.md) | Members: how to use veil, and every command |
| [VEIL.md](docs/VEIL.md) | The name, and why it shapes everything |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the parts fit, flows, storage, privacy |
| [DESIGN.md](docs/DESIGN.md) | Visual language, components, motion |
| [DECISIONS.md](docs/DECISIONS.md) | Why things are the way they are |
| [LIMITS.md](docs/LIMITS.md) | Every external limit, with its source |
| [RUNBOOK.md](docs/RUNBOOK.md) | Setup, deploy, tests, logs |
| [PHASES.md](docs/PHASES.md) | Build plan and status |

## Status

Phases 0–4 are done: runner, front door, search to delivery, mini app, direct crossing, and the review pass. Next is Phase 5, **Beyond**: suggestions drawn from what crossed, verified against MusicBrainz.
