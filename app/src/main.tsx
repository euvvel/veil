import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, live, type HubEvent, type Me, type Prefs, type SessionState } from "./api.ts";
import { Crossings } from "./crossings.tsx";
import { Receive } from "./receive.tsx";
import { Seek } from "./seek.tsx";
import "./styles.css";
import { applyTheme, haptic, tg } from "./tg.ts";

/** Hub events fan out to whichever view is listening. */
export const bus = new EventTarget();
export const onHub = (fn: (e: HubEvent) => void) => {
  const h = (ev: Event) => fn((ev as CustomEvent<HubEvent>).detail);
  bus.addEventListener("hub", h);
  return () => bus.removeEventListener("hub", h);
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string): void {
  bus.dispatchEvent(new CustomEvent("toast", { detail: text }));
}

const LABEL: Record<SessionState, [string, string]> = {
  offline: ["The veil is closed", "Runner off"],
  booting: ["Thinning…", "Starting"],
  ready: ["The veil is open", "Connected"],
  draining: ["The veil is falling", "Shutting down"],
};

type Tab = "seek" | "crossings" | "beyond";

function Strip({ state, onGear }: { state: SessionState; onGear: () => void }) {
  return (
    <header class="strip">
      <span class={`mist ${state}`} aria-hidden="true" />
      <span class="veil">{LABEL[state][0]}</span>
      <span class="plain">· {LABEL[state][1]}</span>
      <button class="gear" aria-label="Settings" onClick={onGear}>⚙︎</button>
    </header>
  );
}

function Settings({ prefs, onClose, onSaved }: { prefs: Prefs; onClose: () => void; onSaved: (p: Prefs) => void }) {
  const [p, setP] = useState(prefs);
  const save = async (patch: Partial<Prefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    try {
      onSaved(await api.prefs(patch));
      haptic.tap();
    } catch {
      toast("The veil did not hear that. Try again.");
    }
  };
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet" role="dialog" aria-label="Settings">
        <h2>Settings</h2>
        <div class="field">
          <span>Default format<small>Used when you seek</small></span>
          <div class="seg">
            {(["flac", "mp3", "any"] as const).map((f) => (
              <button class={p.format === f ? "on" : ""} onClick={() => save({ format: f })}>{f === "any" ? "Any" : f.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <div class="field">
          <span>Largest file<small>{p.max_mb} MB · bigger ones sink to the bottom</small></span>
          <input type="range" min={30} max={500} step={10} value={p.max_mb}
            onInput={(e) => setP({ ...p, max_mb: Number((e.target as HTMLInputElement).value) })}
            onChange={(e) => save({ max_mb: Number((e.target as HTMLInputElement).value) })} />
        </div>
        <div class="field">
          <span>MP3 320 fallback<small>When no FLAC fits, show MP3 320 first</small></span>
          <input type="checkbox" checked={p.fallback} onChange={(e) => save({ fallback: (e.target as HTMLInputElement).checked })} />
        </div>
      </div>
    </>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState(false);
  const [state, setState] = useState<SessionState>("offline");
  const [tab, setTab] = useState<Tab>("seek");
  const [settings, setSettings] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const receiveGid = location.hash.match(/^#receive\/([0-9a-f]+)$/)?.[1];

  useEffect(() => {
    applyTheme();
    tg?.onEvent("themeChanged", applyTheme);
    tg?.ready();
    tg?.expand();
    api.me().then((m) => {
      setMe(m);
      setState(m.session.state);
    }, () => setDenied(true));
    const stop = live((e) => {
      if (e.type === "session.state") setState(e.data.state);
      bus.dispatchEvent(new CustomEvent("hub", { detail: e }));
    });
    const onToast = (ev: Event) => {
      setNote((ev as CustomEvent<string>).detail);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setNote(null), 2800);
    };
    bus.addEventListener("toast", onToast);
    return () => {
      stop();
      bus.removeEventListener("toast", onToast);
    };
  }, []);

  if (denied) return <div class="empty">Nothing is here.</div>;
  if (!me) return <div class="empty">…</div>;

  return (
    <>
      <Strip state={state} onGear={() => setSettings(true)} />
      {receiveGid ? (
        <Receive gid={receiveGid} />
      ) : (
        <>
          <nav class="tabs">
            {(["seek", "crossings", "beyond"] as const).map((t) => (
              <button class={tab === t ? "on" : ""} onClick={() => { haptic.tap(); setTab(t); }}>
                {t === "seek" ? "Seek" : t === "crossings" ? "Crossings" : "Beyond"}
              </button>
            ))}
          </nav>
          <div hidden={tab !== "seek"}><Seek prefs={me.prefs} onCrossed={() => setTab("crossings")} /></div>
          <div hidden={tab !== "crossings"}><Crossings visible={tab === "crossings"} /></div>
          {tab === "beyond" && (
            <div class="beyond">
              <p>What lies beyond is still veiled.</p>
              <small>Suggestions arrive in a later phase.</small>
            </div>
          )}
        </>
      )}
      {settings && <Settings prefs={me.prefs} onClose={() => setSettings(false)} onSaved={(p) => setMe({ ...me, prefs: p })} />}
      {note && <div class="toast" role="status">{note}</div>}
    </>
  );
}

render(<App />, document.getElementById("root")!);
