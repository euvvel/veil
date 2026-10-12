# Decisions

Short records of decisions that shape the project. Newest at the bottom.

### D1 · Runner on GitHub Actions (2026-10-11)
- **Decision:** host the runner on GitHub Actions, using a second GitHub account and a public repo.
- **Context:** free unlimited minutes for public repos. The owner knowingly accepts the risk that GitHub's terms on Actions usage could get the account banned. This is a test phase before buying a VPS.
- **Consequence:** the runner must be host-agnostic (`runner/start.sh` + env vars) so moving to a VPS changes only the doorbell. Public logs force strict log hygiene.

### D2 · Local Telegram Bot API server on the runner (2026-10-11)
- **Decision:** run `telegram-bot-api` on the runner.
- **Context:** the cloud Bot API caps uploads at 50 MB, while a local server allows up to 2,000 MB. Lossless tracks and hi-res files often exceed 50 MB.
- **Consequence:** needs `api_id`/`api_hash` from my.telegram.org and adds boot time (🧪). This led to D3.

### D3 · Two bots: veil (front) and courier (delivery) (2026-10-11)
- **Decision:** use one bot per Bot API server.
- **Context:** a bot must `logOut` from the cloud before running on a local server and can't return to the cloud for 10 minutes. The front bot needs to stay on the cloud with a webhook. A second bot avoids the conflict.
- **Consequence:** each user starts courier once. Revisit if the spike shows a single bot can safely do both.

### D4 · Metadata sources: MusicBrainz + ListenBrainz only (2026-10-11)
- **Decision:** use MusicBrainz and ListenBrainz only. No Last.fm, so no third-party API key.
- **Rule:** every suggestion must carry an MBID that we fetched ourselves. Workers AI only ranks and writes reasons.

### D5 · Format chosen per search, with size awareness (2026-10-11)
- **Decision:** a `FLAC · MP3 · Any` toggle per search, with prefs `format=flac`, `max_mb=150`, `fallback=true`.
- **Delivery:** FLAC via `sendDocument`, MP3/M4A via `sendAudio`. Never transcode.

### D6 · Single Hub Durable Object (2026-10-11)
- **Decision:** one DO instance.
- **Context:** there is one runner and two users. A single DO is the session state, the WS hub, and the job pump.
- **Consequence:** with more runners later, this splits into one Hub per runner.

### D7 · Invite-only access, no stored Telegram ids (2026-10-11)
- **Decision:** no hand-maintained list of user IDs. Access works like this:
  - The admin claims the bot once with a secret link.
  - Members join through single-use invite links that expire in 24 h (`/invite`).
  - Members are stored only as `HMAC(MEMBER_HMAC_KEY, telegram_id)`.
- **Context:** collecting IDs by hand is overhead, and storing raw IDs isn't needed. A gate is still required, because bot usernames are publicly searchable and an open bot would let strangers drive the runner and the Soulseek account.
- **Consequence:**
  - Non-members get total silence: no reply, no commands, 404 from the API.
  - The courier bot never processes updates.
  - A raw chat id exists only on an in-flight job and is cleared on delivery.

### D8 · Files over 50 MB: direct crossing, then into the chat (2026-10-12)
- **Context:**
  - Without an API ID there is no local Bot API server.
  - A bot can only *upload* 50 MB. Re-sending a `file_id` has no limit, but getting a file onto Telegram's servers above 50 MB needs an MTProto client, which needs an API ID.
  - The owner rules out any change to the file: no transcoding, no re-compression, no splitting.
- **Decision:**
  - Oversize files are streamed **untouched** from the runner through a **named Cloudflare Tunnel** (owner's domain; quick tunnels rejected) to the veil mini app, using a one-time signed link.
  - The mini app offers **"Put it in the chat"**: the Web Share API hands the file to the user's own Telegram app, which uploads it.
  - Fallback is **"Save to device"** with `WebApp.downloadFile` (Bot API 8.0).
- **Consequence:**
  - The runner keeps an unclaimed file at most 30 min, then deletes it.
  - The runner stays up until the file is claimed or that time passes.
  - When an API ID becomes available, courier sends up to 2 GB automatically, and this path remains the fallback above 2 GB.

### D8a · Direct crossing ends on the device, not in the chat (2026-10-12)
- **Finding:** Chromium refuses Web Share above **50 MB** in total: `kMaxSharedFileBytes = 50U * 1024 * 1024` in `third_party/blink/renderer/modules/webshare/navigator_share.cc`, rejecting with `NotAllowedError: Permission denied`. Every direct file is over 50 MB by definition, so the "Put it in the chat" share path from D8 can never work. Owner's test 2026-10-12: Chrome 155 on Android, 51 MB, silent failure.
- **Decision:**
  - Remove the share path and the browser page.
  - Direct crossing offers **Save to device** (`downloadFile`), then tells the member how to attach it to a chat themselves (📎 → File).
- **Consequence:** automatic delivery into the chat above 50 MB needs the local Bot API server, which needs an API ID (Route A). There is no other honest path.

### D9 · More results, paged (2026-10-12)
- **Context:**
  - Searches returned few results. The agent sent `searchTimeout: 15000` (slskd reads seconds), kept 25 folders, and the bot showed 8 items with no paging.
- **Decision:**
  - The runner: 12 s timeout, 500 peers, partial snapshots every 5 s, up to 120 folders × 40 files per frame.
  - The Hub keeps up to 400 ranked items per view.
  - The bot pages by 8 (`◀ n / N ▶`); the app loads 30 at a time with *Show more*.
  - Headers count both views.
- **Consequence:** the app fills in while Soulseek answers. App taps carry `name|size`, so a re-rank between frames can't cross the wrong file.

### D10 · One source for help (2026-10-12)
- **Decision:** `worker/src/help.ts` defines every command and the guide text. It feeds the bot's `/help`, the per-chat menus (self-refreshing through `MENU_VERSION`) and the mini app's Guide.
- **Consequence:** `test/help.test.ts` keeps [GUIDE.md](GUIDE.md) in step. Plain words in the chat search, and an unknown command points to `/help`.
