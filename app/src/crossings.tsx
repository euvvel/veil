import { useEffect, useState } from "preact/hooks";
import { api, type Crossing, type HistoryRow } from "./api.ts";
import { onHub } from "./main.tsx";
import { haptic } from "./tg.ts";

/** Overall progress of a crossing, 0–100, for the parting. */
function progress(c: Crossing): number {
  const per = c.jobs.map((j) =>
    j.state === "delivered" || j.state === "awaiting" ? 100 : j.state === "uploading" ? 96 : j.state === "downloading" ? (j.pct ?? 0) * 0.95 : 0,
  );
  return per.reduce((a, b) => a + b, 0) / Math.max(1, per.length);
}

function Row({ c }: { c: Crossing }) {
  const lost = c.jobs.every((j) => j.state === "failed");
  const awaiting = c.jobs.some((j) => j.state === "awaiting");
  const p = progress(c);
  return (
    <div class={`crossing layer ${c.done ? "closed" : ""} ${lost ? "lost" : ""}`} style={{ "--p": c.done ? 0 : p / 2 }}>
      <div class="half l" />
      <div class="half r" />
      <div class="name">{c.name}</div>
      <div class="text">{c.text.replace(` · ${c.name}`, "")}</div>
      <div class="trace" style={{ "--p": c.done ? 0 : p }} />
      {awaiting && !c.done && (
        <div class="act">
          <a class="btn lead" href={`#receive/${c.gid}`} onClick={() => setTimeout(() => location.reload(), 0)}>Receive it</a>
        </div>
      )}
    </div>
  );
}

export function Crossings({ visible }: { visible: boolean }) {
  const [active, setActive] = useState<Crossing[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const refresh = () =>
    api.crossings().then((r) => {
      setActive(r.active);
      setHistory(r.history);
    }, () => {});

  useEffect(() => {
    if (visible) refresh();
  }, [visible]);

  useEffect(
    () =>
      onHub((e) => {
        if (e.type !== "crossing") return;
        const c = e.data;
        setActive((list) => {
          const i = list.findIndex((x) => x.gid === c.gid);
          return i < 0 ? [c, ...list] : list.map((x, n) => (n === i ? c : x));
        });
        if (c.done) {
          // Crossed: the veil falls back, the row fades to a line, then joins the history.
          if (c.jobs.some((j) => j.state === "delivered")) haptic.ok();
          else haptic.fail();
          setTimeout(() => {
            setActive((list) => list.filter((x) => x.gid !== c.gid));
            refresh();
          }, 2200);
        }
      }),
    [],
  );

  return (
    <section>
      {active.length === 0 && history.length === 0 && <div class="empty">Nothing has crossed yet.</div>}
      <div class="stack">{active.map((c) => <Row key={c.gid} c={c} />)}</div>
      {history.length > 0 && (
        <div class="history">
          <h3>Crossed</h3>
          <ul>
            {history.map((h) => (
              <li>
                {h.artist && h.title ? `${h.artist} – ${h.title}` : h.name}
                <span>{(h.format ?? "").toUpperCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
