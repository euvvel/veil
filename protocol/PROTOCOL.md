# Hub ↔ runner protocol, v1

Our own protocol: JSON text frames over the runner's WebSocket (`/hub/runner`, `Authorization: Bearer RUNNER_SECRET`).

**Mirrors:** keep both sides in sync with this file.
- TypeScript types: `worker/src/protocol.ts`
- Python: `runner/agent/hub.py`

```
{ "v": 1, "type": "<domain>.<verb>", "ts": <unix ms>, "data": { … } }
```

## Runner → Hub

| type | data | when |
|---|---|---|
| `runner.hello` | `run_id`, `session_id`, `agent`, `active_jobs: string[]`, `max_upload_mb`, `direct_base` (tunnel URL, if any) | on every (re)connect |
| `runner.heartbeat` | `active_jobs: number`, `idle_s` | every 30 s |
| `search.results` | `search_id`, `responses`, `files`, `folders: Folder[]` | search finished (one message, pre-trimmed) |
| `job.state` | `job_id`, `state`, plus `pct`, `place`, `kbps`, `error`, `track` | state change, or progress at most every 2 s |
| `session.state` | `state: "draining"` | idle timeout, hard cap, or `session.drain` |
| `runner.bye` | `reason` | last message before exit |

`Folder` (compact, to keep frames small):
```
{ "u": username, "d": directory, "f": hasFreeUploadSlot, "q": queueLength, "s": uploadSpeed,
  "files": [[path, size, ext, bitRate|null, bitDepth|null, sampleRate|null, lengthSec|null], …] }
```
The runner sends at most 25 folders × 25 audio files, chosen so that both FLAC and MP3 folders are present.

Job `state` values:

| state | extra fields |
|---|---|
| `queued` | `place` |
| `downloading` | `pct`, `kbps` |
| `uploading` | |
| `awaiting` | `token`: direct mode, the file is ready behind the tunnel (D8) |
| `delivered` | `track` |
| `failed` | `error` category: `connect`, `timeout`, `rejected`, `queue`, `not_shared`, `too_large`, `not_found`, `upload`, `cancelled`, `unclaimed`, `unknown` |
| `pending` | handed back during a drain |

`track` = `{ artist, title, album, year, format, bitrate, mb_recording, mb_release, message_id }`, filled from the file's tags where present.

## Hub → runner

| type | data |
|---|---|
| `hub.welcome` | `state` |
| `search.start` | `search_id`, `query` |
| `job.start` | `job_id`, `peer`, `path`, `size`, `chat_id`, `caption`, `mode` (`chat` or `direct`) |
| `job.release` | `job_id`: the member has the file; delete it and report `delivered` |
| `job.cancel` | `job_id` |
| `session.drain` | — |

## Rules
- **Peer names, paths and chat ids appear only in these frames and in transient Hub storage.** D1 erases them on delivery (see ARCHITECTURE.md).
- **`job.start` is idempotent:** the runner ignores a `job_id` it already has.
- **Recovering jobs on hello:** the Hub re-sends every non-terminal D1 job that isn't in `active_jobs`, adding 1 to `attempts`. After 3 openings, the job is failed with `gave_up`.
