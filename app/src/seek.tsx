import { useEffect, useRef, useState } from "preact/hooks";
import { api, mb, type Fmt, type Item, type Prefs, type SearchView, type View } from "./api.ts";
import { onHub, toast } from "./main.tsx";
import { haptic, tg, token } from "./tg.ts";

const FMT_LABEL: Record<Fmt, string> = { flac: "FLAC", mp3: "MP3", any: "Any" };
const PAGE = 30;
const keyOf = (it: Item) => `${it.name}|${it.size}`;

function Avail({ it }: { it: Item }) {
  return <span class={`avail ${it.free ? "free" : ""}`} title={it.free ? "free slot" : "queued"} aria-label={it.free ? "free slot" : "queued"} />;
}

/** The chip already says the format, so the line drops it ("FLAC 24/96 · 18 MB" → "24/96 · 18 MB"). */
const detailOf = (it: Item) =>
  it.detail.replace(/ · (free|queue \d+)$/, "").replace(new RegExp(`^${it.ext.toUpperCase()} ?`), "").replace(/^ · /, "");
const nameOf = (it: Item) => (it.kind === "t" ? it.name.replace(/\.[a-z0-9]{2,5}$/i, "") : it.name);
const stripExt = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, "");

function Row({ it, selected, open, onTap }: { it: Item; selected: boolean; open: boolean; onTap: () => void }) {
  const chip = it.kind === "a" ? "ALBUM" : it.ext.toUpperCase();
  return (
    <div class={`result layer ${selected ? "sel" : ""}`}>
      <button class="result-main" onClick={onTap} aria-expanded={it.kind === "a" ? open : undefined}>
        <span class={`chip ${it.kind === "a" ? "album" : it.ext}`}>{chip}</span>
        <span class="result-body">
          <span class="name">{nameOf(it)}</span>
          <span class="detail">
            {detailOf(it) || (it.kind === "a" ? it.detail : "")}
            {it.direct && <span class="badge">direct</span>}
          </span>
        </span>
        <Avail it={it} />
      </button>
      {it.kind === "a" && open && (
        <ol class="tracks">
          {it.files.map((f) => (
            <li>
              <span>{stripExt(f.name)}</span>
              <span class="dim">{mb(f.size)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Seek({ prefs, ask }: { prefs: Prefs; ask: { query: string; n: number } | null }) {
  const [query, setQuery] = useState("");
  const [fmt, setFmt] = useState<Fmt>(prefs.format);
  const [view, setView] = useState<View>("t");
  const [sid, setSid] = useState<string | null>(null);
  const [res, setRes] = useState<SearchView | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const last = useRef("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.recent().then(setRecent, () => {});
  }, []);

  /** Load the first page (or as many as already shown, so partial refreshes keep your place). */
  const load = async (s: string, v = view, f = fmt, keep = PAGE) => {
    const r = await api.view(s, v, f, 0, Math.min(Math.max(keep, PAGE), 60));
    setRes(r);
    setItems(r.items);
    return r;
  };

  // Results stream in over the Hub socket; a slow poll covers a missed frame.
  useEffect(() => {
    if (!sid) return;
    const off = onHub((e) => {
      if ((e.type === "search.done" || e.type === "search.update") && e.data.sid === sid) load(sid, view, fmt, items.length).catch(() => {});
    });
    const poll = setInterval(() => {
      if (res?.status !== "done") load(sid, view, fmt, items.length).catch(() => {});
    }, 6000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [sid, res?.status, view, fmt, items.length]);

  const listening = Boolean(sid && res?.status !== "done" && res?.status !== "gone");

  useEffect(() => {
    if (!listening && !busy) return setSince(null);
    setSince((s) => s ?? Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [listening, busy]);
  const secs = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;

  const seek = async (q0?: string) => {
    const q = (q0 ?? query).trim();
    const key = `${q.toLowerCase()}|${fmt}`;
    if (!q || busy || (listening && key === last.current)) return;
    if (q0) setQuery(q0);
    last.current = key;
    input.current?.blur();
    setBusy(true);
    setSel(null);
    setRes(null);
    setItems([]);
    setSince(Date.now());
    haptic.soft();
    try {
      const r = await api.search(q, fmt);
      setSid(r.sid);
      setView("t");
      setRecent((list) => [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8));
    } catch {
      last.current = "";
      toast("The veil did not hear that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // A request from elsewhere (a past crossing tapped in Crossings) seeks it again.
  useEffect(() => {
    if (ask) seek(ask.query);
  }, [ask?.n]);

  const switchTo = async (v: View, f: Fmt) => {
    setView(v);
    setFmt(f);
    setSel(null);
    haptic.tap();
    if (sid && res && res.status !== "pending" && res.status !== "sent") await load(sid, v, f).catch(() => {});
  };

  const showMore = async () => {
    if (!sid || !res) return;
    setMore(true);
    try {
      const r = await api.view(sid, view, fmt, items.length, PAGE);
      setItems((list) => [...list, ...r.items.filter((x) => !list.some((y) => y.i === x.i))]);
      setRes((old) => (old ? { ...old, total: r.total, counts: r.counts } : r));
    } finally {
      setMore(false);
    }
  };

  const selected = items.find((x) => keyOf(x) === sel);

  const cross = async () => {
    if (!sid || !selected) return;
    tg?.MainButton.showProgress();
    try {
      const r = await api.cross(sid, selected.i, keyOf(selected));
      if (r.ok) {
        haptic.ok();
        toast(selected.kind === "a" ? `Letting ${selected.files.length} files cross.` : "Let it cross.");
        setSel(null);
      } else {
        haptic.fail();
        toast(r.error ?? "That one would not cross.");
      }
    } catch {
      toast("The veil did not hear that. Try again.");
    } finally {
      tg?.MainButton.hideProgress();
    }
  };

  // Telegram's main button carries the one decisive action.
  useEffect(() => {
    const b = tg?.MainButton;
    if (!b) return;
    const text = !selected ? "" : selected.kind === "a" ? `Let ${selected.files.length} files cross` : selected.direct ? "Let it cross (directly)" : "Let it cross";
    b.setParams({ text, is_visible: Boolean(selected), is_active: true, color: token("--spirit"), text_color: token("--void") });
    b.onClick(cross);
    return () => b.offClick(cross);
  }, [sel, sid, items]);

  const tally = res && (res.status === "done" || res.status === "partial")
    ? `${res.counts.tracks} tracks · ${res.counts.albums} albums`
    : "";

  return (
    <section>
      <form class="seekbar layer" onSubmit={(e) => { e.preventDefault(); seek(); }}>
        <input ref={input} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="Artist, album, title…" enterKeyHint="search" autoComplete="off" aria-label="Seek" />
        {query && !busy && (
          <button type="button" class="clear" aria-label="Clear" onClick={() => { setQuery(""); input.current?.focus(); }}>×</button>
        )}
        <button class="btn lead" type="submit" disabled={!query.trim() || busy || (listening && `${query.trim().toLowerCase()}|${fmt}` === last.current)}>
          {busy || listening ? `${secs}s` : "Seek"}
        </button>
      </form>

      {!sid && recent.length > 0 && (
        <div class="chips" aria-label="Recent searches">
          {recent.map((q) => <button class="chip-btn" onClick={() => seek(q)}>{q}</button>)}
        </div>
      )}

      <div class="row-controls">
        <div class="seg" role="group" aria-label="Format">
          {(["flac", "mp3", "any"] as const).map((f) => (
            <button class={fmt === f ? "on" : ""} aria-pressed={fmt === f} onClick={() => switchTo(view, f)}>{FMT_LABEL[f]}</button>
          ))}
        </div>
        {sid && (
          <div class="seg" role="group" aria-label="View">
            <button class={view === "t" ? "on" : ""} aria-pressed={view === "t"} onClick={() => switchTo("t", fmt)}>Tracks</button>
            <button class={view === "a" ? "on" : ""} aria-pressed={view === "a"} onClick={() => switchTo("a", fmt)}>Albums</button>
          </div>
        )}
      </div>

      {sid && (tally || listening) && (
        <p class="summary">
          {tally}
          {listening && <span class="listening">{tally ? " · still listening" : `Listening beyond · ${secs}s`}</span>}
        </p>
      )}
      {res?.note && <p class="note">{res.note}</p>}

      {sid && listening && items.length === 0 && <div class="empty">Listening beyond…</div>}
      {res?.status === "gone" && <div class="empty">That search has faded. Seek again.</div>}
      {res?.status === "done" && items.length === 0 && <div class="empty">Nothing answered from beyond.</div>}
      {!sid && recent.length === 0 && <div class="empty">What do you seek?</div>}

      {items.length > 0 && (
        <div class="results">
          {items.map((it) => (
            <Row key={keyOf(it)} it={it} selected={sel === keyOf(it)} open={sel === keyOf(it)}
              onTap={() => { haptic.tap(); setSel(sel === keyOf(it) ? null : keyOf(it)); }} />
          ))}
        </div>
      )}

      {res && items.length < res.total && (
        <button class="btn more" onClick={showMore} disabled={more}>
          {more ? "…" : `Show more · ${res.total - items.length} left`}
        </button>
      )}

      {!tg && selected && (
        <p><button class="btn lead" onClick={cross}>{selected.kind === "a" ? `Let ${selected.files.length} files cross` : "Let it cross"}</button></p>
      )}
    </section>
  );
}
