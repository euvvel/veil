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

Dark-first. The app reads Telegram `themeParams`, uses `bg_color` as its base, and lays the veil tokens over it so it still feels native in Telegram's light theme.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--void` | `#0b0a0f` | `#f4f2ee` | page field, used only if Telegram gives no bg |
| `--veil-1` | `rgba(220,214,240,.06)` | `rgba(30,24,50,.04)` | first layer (lists) |
| `--veil-2` | `rgba(220,214,240,.12)` | `rgba(30,24,50,.08)` | raised layer (sheets, focused row) |
| `--ink` | `#e9e6f2` | `#1d1a24` | primary text |
| `--ink-dim` | `rgba(233,230,242,.55)` | `rgba(29,26,36,.55)` | secondary text, plain labels |
| `--ember` | `#c8a96a` | `#8a6a2a` | the single accent: crossing progress, primary action |
| `--lost` | `#b5626a` | `#9a3f48` | failures only |

Use one accent colour only. Gold-ember is candlelight seen through fabric.

### Type
- **Display:** *Cormorant Garamond* (or a similar old-style serif), self-hosted in Worker assets so no third-party font request is made. Used for screen titles, track titles in the crossing, and Explore reasons.
- **UI:** the system stack (`-apple-system, Roboto, …`) for everything functional: sizes, bitrates, buttons.
- The pairing reflects the theme: the poem's voice for things beyond, and plain type for the machinery.

### Surfaces
- Layers use `backdrop-filter: blur(12px)` plus a `--veil-*` fill and a 1px hairline at 8% ink. If blur isn't supported, fall back to a solid fill.
- **A fine, slowly drifting grain** over the background (CSS noise, 3–4% opacity) gives the impression of fabric. Static when `prefers-reduced-motion`.

## Motion

| Moment | Motion |
|---|---|
| booting | The background mist slowly brightens (opacity 0.4 → 1 over the boot). |
| downloading | **The parting:** two translucent halves over the row draw apart from the centre as progress grows. The ember line in the gap is the progress bar. |
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
