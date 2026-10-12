# Design

veil's interface follows its name: see [VEIL.md](VEIL.md). A veil is **thin, translucent, provisional**. It hides, reveals, parts briefly, then falls back. Every visual and interaction decision should map to one of those words. If it doesn't, cut it.

## Principles

1. **Translucent, not opaque.** Surfaces are layers of mist over a dark field, not solid cards. Depth comes from blur and opacity, not shadows.
2. **Provisional.** Nothing in the UI suggests permanence or a library. There's no "my collection", only *crossings* (history as text) and what lies *beyond* (Explore).
3. **The crossing is the moment.** The one rich animation in the app belongs to a track crossing over. Everything else stays still and quiet.
4. **Leaves nothing behind.** A delivered item fades into a single line of text. The file lives in Telegram, not here.
5. **Plain words underneath.** Poetic labels always come with a plain status beside them, so it's never unclear what is happening.

## Vocabulary

| State | Veil label | Plain label (secondary) |
|---|---|---|
| offline | The veil is closed | Runner off |
| booting | Thinning… | Starting, ~2–3 min |
| ready | The veil is open | Connected |
| searching | Listening beyond | Searching |
| queued(n) | At the threshold · n ahead | Queued at peer |
| downloading | Crossing over · 42% | Downloading |
| uploading | Arriving | Sending to Telegram |
| delivered | Crossed | In your chat |
| failed | Lost in the veil | Failed: reason |
| draining | The veil is falling | Shutting down |

Screen names:
- **Seek:** search.
- **Crossings:** history and the live job list.
- **Beyond:** Explore, with its feeds *More like this*, *Same hand* (same artist), *Deep cuts*, *Rabbit hole*, and *This week's veil* (weekly mix).

## Visual language

### Colour

Moonlight on the far side of the veil (revised 2026-10-12 at the owner's request: "darker and mystical", away from warm candlelight). The app keeps its own field and paints Telegram's header and background to match, so the frame dissolves into it.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--void` | `#050408` | `#e9e8ee` | the field: black with a violet undertone |
| `--deep` | `#110d20` | `#d9d6e4` | the glow at the top of the field, sheets |
| `--veil-1` | `rgba(160,150,210,.045)` | `rgba(40,30,80,.04)` | first layer (lists), fog |
| `--veil-2` | `rgba(160,150,210,.09)` | `rgba(40,30,80,.08)` | raised layer, selection, the parting halves |
| `--ink` | `#d6d2e4` | `#15131c` | primary text, cold and pale |
| `--ink-dim` | `rgba(214,210,228,.46)` | `rgba(21,19,28,.55)` | secondary text, plain labels |
| `--spirit` / `--spirit-ink` | `#9c8fd4` / `#cbc3f2` | `#4f428a` / `#3c3170` | the single accent: a spectral violet for the crossing line, the selection glow, the primary action |
| `--lost` | `#8e4656` | `#8a3446` | failures only: a dim crimson |

There is one accent, and it is never warm. Backgrounds carry a faint grain and two slow, blurred fog drifts (70 s); both stop under `prefers-reduced-motion`.

### Type
- **Display:** *IM Fell English* (OFL), the digitised 17th-century Fell types, the printed page of Hawthorne's age. Self-hosted in Worker assets, so no third-party font request is made. Used for the veil's own words: the status line, empty states, Beyond.
- **Small caps:** *IM Fell English SC*, letter-spaced, for the tabs and section headings.
- **UI:** the system stack for everything functional: file names, sizes, bitrates, buttons. IM Fell has no lining figures, so numbers and file names never use it.

### Surfaces
- Layers use `backdrop-filter: blur(12px)` plus a `--veil-*` fill and a 1px hairline at 8% ink. If blur isn't supported, fall back to a solid fill.
- **A fine, slowly drifting grain** over the background (CSS noise, 3–4% opacity) gives the impression of fabric. Static when `prefers-reduced-motion`.

## Motion

| Moment | Motion |
|---|---|
| booting | The background mist slowly brightens (opacity 0.4 → 1 over the boot). |
| downloading | **The parting:** two translucent halves over the row draw apart from the centre as progress grows. A thin spectral line in the gap is the progress bar. |
| delivered | The halves close again, the row collapses to one dim text line, and `HapticFeedback.notificationOccurred('success')` fires. |
| failed | The row dims to `--lost` with no shake. |
| Explore tap | The card's veil lifts (translate-y + fade), then Seek opens prefilled. |

Everything respects `prefers-reduced-motion`: motion is replaced by simple opacity changes.

## Telegram integration

- `WebApp.ready()` and `expand()`, and the header/background colours come from tokens.
- The **MainButton** is the primary action per screen: *Seek*, *Let it cross* (download), *Cross all* (album).
- The **BackButton** handles navigation. Haptics are used on select, deliver, and fail.
- The app must work at 320px width and in Telegram's light theme.

## Screens (as built)

1. **Seek**
   - **Search field:** a clear button (×), and a submit button that becomes a seconds counter while listening, so the wait is visible and a second tap can't send the same search again.
   - **Recent searches:** chips shown before the first search. Tap one to seek it again.
   - **Filters:** `FLAC · MP3 · Any`, plus `Tracks · Albums` once results exist.
   - **Summary:** *"357 tracks · 40 albums"*, with a breathing dot and *still listening* while partial results arrive.
   - **Result row:** format chip (FLAC in spirit, ALBUM filled), name (two lines at most, no extension), a quiet detail line (`24/96 · 18 MB · 2:00`), and an availability dot (filled and glowing = free slot, hollow = queued). A `direct` badge marks files over the chat limit.
   - **Album row:** tap to expand its track list (names and sizes). The main button reads *Let N files cross*.
   - **Paging:** 30 at a time, then *Show more · N left*.
   - **Telegram's MainButton** carries the decisive action, *Let it cross* (or *directly*), in the spirit colour.
2. **Crossings**
   - **Now:** live crossings with the parting animation. A file at the veil's edge shows *Receive it*.
   - **Crossed:** text history (artist – title, album · format · *2 h ago*). Tap a line to seek it again.
3. **Beyond**
   - **Feeds:** one row per feed, scrolling sideways with snap: This week's veil, More like this, From the same hand, Deep cuts.
   - **Card:** cover (Cover Art Archive, slightly desaturated; an initial on a mist gradient when missing), title, artist, year · kind, and the one-line reason in the display serif (italic). A ✕ in the corner skips.
   - **Tap a card:** it seeks that exact release and switches to Seek with the search already running.
   - **Rabbit hole:** chips of your recent artists; the trail appears as a vertical list of cards.
   - **Status line:** *Gathered 2 h ago · ordered by the veil*, with *Gather again*.
4. **Sheets** (slide up from the bottom, with a grip and Esc to close):
   - **The veil** (tap the status strip): state, since when, what happens to large files this session. The keeper also gets *Wake now* or *Let it sleep now*.
   - **Settings** (⚙︎): default format, largest file, MP3 320 fallback, then **Guide** and **About veil**.
   - **Guide:** the same text as the bot's `/help` (from `worker/src/help.ts`).
   - **About:** the veil, Hawthorne's verse, the privacy promise.
5. **Receive** (direct crossing): *Save to device* via Telegram's download popup, then how to attach the file to a chat (📎 → File).

## Status strip

A thin strip at the top of every screen shows the session state: the veil label plus the plain label, with the mist dot. It's the only place the runner's existence is visible. Tap it for details.

## Bot messages

- **Plain words:** they search. Each reply leads with the veil label and gives the expected wait.
- **Results message:**
  - A header line `Seek · query` and `FLAC · tracks · 357 tracks · 40 albums`.
  - 8 numbered items (`quality · size · length · free/queue`), 1–8 buttons that cross.
  - A page row `◀ 2 / 9 ▶`. Disabled arrows show `·`, because Telegram rejects empty labels.
  - The format and view toggles.
  - Edited in place.
- **Crossing status:** one message per crossing, edited as it moves (`Crossing over · 42%` … `Crossed`).
- **`/help`:** the guide prose, then the commands for your role, then an **Open veil** button.

## Interaction rules

- Every touch target is at least 44 px. Focus is visible (a 1 px spirit outline). Toggles carry `aria-pressed` and tabs `role="tab"`.
- Toasts appear under the status strip, never over sheets or the main button.
- Numbers and file names use the UI font. IM Fell has no lining figures.
