import { useEffect, useState } from "preact/hooks";
import { ago, api, type BeyondView, type FeedName, type Suggestion } from "./api.ts";
import { toast } from "./main.tsx";
import { haptic } from "./tg.ts";

const FEEDS: { key: FeedName; title: string; note: string }[] = [
  { key: "weekly", title: "This week's veil", note: "A weekly mix, gathered on Mondays" },
  { key: "like", title: "More like this", note: "Close to what you keep" },
  { key: "same", title: "From the same hand", note: "Records you lack by artists you have" },
  { key: "deep", title: "Deep cuts", note: "Quieter records near your taste" },
];

/** Cover Art Archive by release MBID; loaded straight from archive.org, never stored. */
const coverUrl = (s: Suggestion) => (s.cover ? `https://coverartarchive.org/release/${s.cover}/front-250` : null);

function Cover({ s }: { s: Suggestion }) {
  const [failed, setFailed] = useState(false);
  const url = coverUrl(s);
  if (!url || failed) return <div class="cover blank" aria-hidden="true"><span>{s.artist.slice(0, 1)}</span></div>;
  return <img class="cover" src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Card({ s, onSeek, onSkip }: { s: Suggestion; onSeek: (s: Suggestion) => void; onSkip: (s: Suggestion) => void }) {
  return (
    <article class="card layer">
      <button class="card-main" onClick={() => onSeek(s)} aria-label={`Seek ${s.artist}, ${s.title}`}>
        <Cover s={s} />
        <span class="card-title">{s.title}</span>
        <span class="card-artist">{s.artist}</span>
        <span class="card-meta">{[s.year, s.kind].filter(Boolean).join(" · ")}</span>
        <span class="card-reason">{s.reason}</span>
      </button>
      <button class="card-x" aria-label="Skip" title="Skip for good" onClick={() => onSkip(s)}>×</button>
    </article>
  );
}

export function Beyond({ visible, onSought }: { visible: boolean; onSought: (sid: string, query: string) => void }) {
  const [view, setView] = useState<BeyondView | null>(null);
  const [hole, setHole] = useState<{ artist: string; items: Suggestion[] } | null>(null);
  const [walking, setWalking] = useState<string | null>(null);

  const load = () => api.beyond().then(setView, () => {});

  useEffect(() => {
    if (visible) load();
  }, [visible]);

  // While the Seer is gathering, look again every few seconds.
  useEffect(() => {
    if (!visible || !view || view.status.phase === "idle") return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [visible, view?.status.phase]);

  const seek = async (s: Suggestion) => {
    haptic.soft();
    try {
      const r = await api.beyondSeek(s.id);
      if (r.ok && r.sid && r.query) onSought(r.sid, r.query);
      else toast(r.error ?? "That suggestion has faded.");
    } catch {
      toast("The veil did not hear that. Try again.");
    }
  };

  const skip = async (s: Suggestion) => {
    haptic.tap();
    const drop = (list: Suggestion[]) => list.filter((x) => x.id !== s.id);
    setView((v) => (v ? { ...v, feeds: Object.fromEntries(Object.entries(v.feeds).map(([k, l]) => [k, drop(l)])) as BeyondView["feeds"] } : v));
    setHole((h) => (h ? { ...h, items: drop(h.items) } : h));
    await api.beyondSkip(s.id).catch(() => {});
  };

  const refresh = async () => {
    const r = await api.beyondRefresh().catch(() => ({ ok: false, error: "The veil did not hear that." }));
    if (!r.ok) return toast(r.error ?? "Not now.");
    haptic.soft();
    load();
  };

  const walk = async (artist: string) => {
    setWalking(artist);
    haptic.soft();
    try {
      const r = await api.beyondHole(artist);
      setHole({ artist, items: r.items });
      if (!r.ok) toast("The way out from there is still veiled.");
    } finally {
      setWalking(null);
    }
  };

  if (!view) return <div class="empty">…</div>;
  const gathering = view.status.phase !== "idle";
  const total = FEEDS.reduce((n, f) => n + (view.feeds[f.key]?.length ?? 0), 0);

  if (view.status.empty && !total) {
    return (
      <div class="beyond">
        <p>What lies beyond is still veiled.</p>
        <small>Let a few things cross; the veil learns from what you keep.</small>
      </div>
    );
  }

  return (
    <section class="beyond-feeds">
      <p class="summary">
        {gathering ? <span class="listening">Gathering what lies near your crossings…</span>
          : view.status.builtAt ? `Gathered ${ago(view.status.builtAt)}${view.status.by === "ai" ? " · ordered by the veil" : ""}` : ""}
        {!gathering && <button class="link-btn" onClick={refresh}>Gather again</button>}
      </p>

      {!total && gathering && <div class="empty">The veil is thinning…</div>}

      {FEEDS.map((f) =>
        view.feeds[f.key]?.length ? (
          <div class="feed">
            <h3 class="section">{f.title}</h3>
            <p class="feed-note">{f.note}</p>
            <div class="feed-row">
              {view.feeds[f.key].map((s) => <Card key={s.id} s={s} onSeek={seek} onSkip={skip} />)}
            </div>
          </div>
        ) : null,
      )}

      {view.artists.length > 0 && (
        <div class="feed">
          <h3 class="section">Rabbit hole</h3>
          <p class="feed-note">Choose one of yours; the veil walks outward, one record per step</p>
          <div class="chips">
            {view.artists.map((a) => (
              <button class={`chip-btn ${hole?.artist === a ? "on" : ""}`} disabled={Boolean(walking)} onClick={() => walk(a)}>
                {walking === a ? "Walking…" : a}
              </button>
            ))}
          </div>
          {hole && (
            <ol class="trail">
              {hole.items.map((s) => (
                <li>
                  <Card s={s} onSeek={seek} onSkip={skip} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
