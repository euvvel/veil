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

## Screens

1. **Seek:**
   - A query field with a format toggle `FLAC · MP3 · Any` (default from prefs).
   - Results are grouped by folder (album), with peer score, total size, bitrate, free slot, and queue.
   - Oversized files (> `max_mb`) carry a quiet size badge, not a warning colour.
2. **Crossings:** live jobs at the top (with the parting animation) and the text history below.
3. **Beyond:**
   - One horizontal row per feed. Each card shows artist, title, year, and a one-line reason in the display serif.
   - Long-press means skip, which is recorded as feedback.
4. **Settings (sheet):** format default, `max_mb`, fallback toggle, idle timeout. Admins also see invites and approvals.

## Status bar

A thin strip at the top of every screen shows the session state, using the veil label plus the plain label. It's the only place the runner's existence is visible.
