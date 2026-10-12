import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Fmt, type Prefs, type SearchView, type View } from "./api.ts";
import { onHub, toast } from "./main.tsx";
import { haptic, tg, token } from "./tg.ts";

const FMT_LABEL: Record<Fmt, string> = { flac: "FLAC", mp3: "MP3", any: "Any" };

export function Seek({ prefs, onCrossed }: { prefs: Prefs; onCrossed: () => void }) {
  const [query, setQuery] = useState("");
  const [fmt, setFmt] = useState<Fmt>(prefs.format);
  const [view, setView] = useState<View>("t");
  const [sid, setSid] = useState<string | null>(null);
  const [res, setRes] = useState<SearchView | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = async (s: string, v?: View, f?: Fmt) => {
    const r = await api.view(s, v, f);
    setRes(r);
    return r;
  };

  // Results arrive over the Hub socket; a slow poll covers a missed frame.
  useEffect(() => {
    if (!sid) return;
    const off = onHub((e) => {
      if (e.type === "search.done" && e.data.sid === sid) load(sid);
    });
    const poll = setInterval(() => {
      if (res?.status !== "done") load(sid).catch(() => {});
    }, 6000);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [sid, res?.status]);

  const seek = async (e?: Event) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    input.current?.blur();
    setBusy(true);
    setSel(null);
    setRes(null);
    try {
      const r = await api.search(q, fmt);
      setSid(r.sid);
      setView("t");
      haptic.soft();
    } catch {
      toast("The veil did not hear that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const switchTo = async (v: View, f: Fmt) => {
    setView(v);
    setFmt(f);
    setSel(null);
    haptic.tap();
    if (sid && res?.status === "done") await load(sid, v, f);
  };

  // The Telegram main button carries the one decisive action: let it cross.
  useEffect(() => {
    const mb = tg?.MainButton;
    if (!mb) return;
    const item = sel !== null ? res?.items[sel] : undefined;
    const go = async () => {
      if (!sid || !item) return;
      mb.showProgress();
      try {
        const r = await api.cross(sid, item.i);
        if (r.ok) {
          haptic.ok();
          setSel(null);
          onCrossed();
        } else {
          haptic.fail();
          toast(r.error ?? "That one would not cross.");
        }
      } catch {
        toast("The veil did not hear that. Try again.");
      } finally {
        mb.hideProgress();
      }
    };
    mb.setParams({
      text: item?.direct ? "Let it cross (directly)" : "Let it cross",
      is_visible: Boolean(item),
      is_active: true,
      color: token("--spirit"),
      text_color: token("--void"),
    });
    mb.onClick(go);
    return () => mb.offClick(go);
  }, [sel, res, sid]);

  const waiting = sid && (!res || res.status === "pending" || res.status === "sent");

  return (
    <section>
      <form class="seekbar layer" onSubmit={seek}>
        <input ref={input} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="Seek an artist, a title…" enterKeyHint="search" autoComplete="off" />
        <button class="btn ember" type="submit" disabled={!query.trim() || busy}>Seek</button>
      </form>

      <div class="row-controls">
        <div class="seg" role="group" aria-label="Format">
          {(["flac", "mp3", "any"] as const).map((f) => (
            <button class={fmt === f ? "on" : ""} onClick={() => switchTo(view, f)}>{FMT_LABEL[f]}</button>
          ))}
        </div>
        {res?.status === "done" && (
          <div class="seg" role="group" aria-label="View">
            <button class={view === "t" ? "on" : ""} onClick={() => switchTo("t", fmt)}>Tracks</button>
            <button class={view === "a" ? "on" : ""} onClick={() => switchTo("a", fmt)}>Albums</button>
          </div>
        )}
      </div>

      {waiting && <div class="empty">Listening beyond…</div>}
      {res?.status === "gone" && <div class="empty">That search has faded. Seek again.</div>}
      {res?.status === "done" && (
        <>
          {res.note && <p class="note">{res.note}</p>}
          {res.items.length === 0 ? (
            <div class="empty">Nothing answered from beyond.</div>
          ) : (
            <div class="results">
              {res.items.map((it, n) => (
                <button class={`result layer ${sel === n ? "sel" : ""}`} onClick={() => { haptic.tap(); setSel(sel === n ? null : n); }}>
                  <div class="name">{it.name}</div>
                  <div class="detail">
                    {it.detail}
                    {it.direct && <span class="badge">direct</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
          {!tg && sel !== null && (
            <p><button class="btn ember" onClick={() => api.cross(sid!, res.items[sel]!.i).then(onCrossed)}>Let it cross</button></p>
          )}
        </>
      )}
    </section>
  );
}
