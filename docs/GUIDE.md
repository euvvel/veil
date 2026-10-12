# veil · guide

How to use veil, for members. The bot's `/help` and the mini app's **Guide** show the same text. Both come from `worker/src/help.ts`, and a test fails if this page misses a command.

## Two ways in

- **The mini app:** tap **veil** next to the message field in the chat with the bot. Use it for browsing results, watching downloads, and settings.
- **The bot:** type what you want in the chat. Plain words search; commands are listed below.

Files always arrive from the courier bot. The first time, open the courier and press **Start** so it may send to you.

## Seeking

Type what you're looking for: artist, album, title. veil asks Soulseek for up to 500 people's answers and shows them within about fifteen seconds.

- **Tracks** are single files. **Albums** are whole folders from one person.
- **FLAC · MP3 · Any** picks the format. FLAC comes first by default. When no FLAC fits your size limit, MP3 320 is offered first instead (Settings → MP3 320 fallback).
- Results are ranked like this:
  1. people with a free upload slot
  2. people who delivered reliably before
  3. shortest queue
  4. fastest connection
- Identical files offered by many people are shown once.
- **Paging:**
  - In the bot: 8 results per page, with `◀ 1 / 9 ▶`.
  - In the mini app: 30 at a time, with **Show more**.
  - Headers count both views, for example *312 tracks · 41 albums*.

## Crossing

Choose a result and **let it cross**. In the mini app, **Crossings** shows the progress:

| You see | Meaning |
|---|---|
| Waiting for the veil | The runner is starting. |
| At the threshold · 3 ahead | The person has you in their upload queue. |
| Crossing over · 42% | Downloading. |
| Arriving | Sending to Telegram. |
| Crossed | It's in your chat from the courier, and gone from the runner. |
| At the veil's edge | Too large for the chat (see below). |
| Lost in the veil · reason | It failed. |

**Failures:** if a person refuses or goes quiet, veil tries the same file (same name and size) from up to three other people before giving up.

**Albums** cross file by file, under one progress line.

### Files over 50 MB

A bot can't send files over 50 MB into a chat. Such files wait **at the veil's edge** for 30 minutes:
1. Open veil.
2. Tap **Receive it** → **Save to device**.
3. To keep it in a chat: open the chat → 📎 → **File**, and pick it from your recent files.

## The runner

veil wakes a short-lived runner when you seek. It's usually open in under half a minute. After 20 quiet minutes it falls asleep, logging out of Soulseek. Nothing is kept: no audio, only a line of text that something crossed.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/seek [flac\|mp3\|any] words` (or `/s`) | everyone | Searches. Without words, it repeats your last search. Plain words without a command do the same. |
| `/history` | everyone | Your last ten crossings, as text. |
| `/status` | everyone | Whether the veil is closed, starting, open or falling. |
| `/help` | everyone | This guide, in short. |
| `/wake` | keeper | Starts the runner without searching, and tells you when it's open. |
| `/sleep` | keeper | Finishes what's being sent, logs out of Soulseek, and stops the runner. |
| `/invite` | keeper | A single-use invite link, valid for 24 hours. |
| `/members` | keeper | Members by short fingerprint, with buttons to revoke. |
| `/leave` | members | Removes you from veil. You'd need a new invite to return. |

## Privacy

- veil stores text only: what you searched, what crossed (artist, title, album, format), and when.
- It never stores audio, and never stores your Telegram id. Members are known by a one-way fingerprint.
- Who sent a file, and its path, are kept only while it crosses, then erased.
