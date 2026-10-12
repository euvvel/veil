import { render, type ComponentChildren } from "preact";
import { useEffect, useErrorBoundary, useState } from "preact/hooks";
import { ago, api, live, type Help, type HubEvent, type Me, type Prefs, type SessionInfo, type SessionState } from "./api.ts";
import { Crossings } from "./crossings.tsx";
import { Receive } from "./receive.tsx";
import { Seek } from "./seek.tsx";
import "./styles.css";
import { report, watchErrors } from "./report.ts";
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
type Sheet = null | "session" | "settings" | "guide" | "about";

function Strip({ state, onTap }: { state: SessionState; onTap: () => void }) {
  return (
    <header class="strip">
      <button class="strip-main" onClick={onTap} aria-label="Session">
        <span class={`mist ${state}`} aria-hidden="true" />
        <span class="veil">{LABEL[state][0]}</span>
        <span class="plain">· {LABEL[state][1]}</span>
      </button>
      <button class="gear" aria-label="Settings" onClick={() => bus.dispatchEvent(new CustomEvent("sheet", { detail: "settings" }))}>⚙︎</button>
    </header>
  );
}

function SheetFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class="sheet" role="dialog" aria-label={title}>
        <div class="grip" aria-hidden="true" />
        <h2>{title}</h2>
        {children}
      </div>
    </>
  );
}

function SessionSheet({ me, state, onClose }: { me: Me; state: SessionState; onClose: () => void }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.session().then(setInfo, () => {});
  }, [state]);
  const act = async (fn: () => Promise<{ ok: boolean }>, done: string) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(r.ok ? done : "The veil did not answer.");
      haptic.tap();
    } finally {
      setBusy(false);
    }
  };
  return (
    <SheetFrame title="The veil" onClose={onClose}>
      <div class="field"><span>State</span><span class="dim">{LABEL[state][0]} · {LABEL[state][1]}</span></div>
      {info && state !== "offline" && <div class="field"><span>Since</span><span class="dim">{ago(info.since)}</span></div>}
      {info && (
        <div class="field">
          <span>Large files<small>Over {info.maxUploadMb} MB</small></span>
          <span class="dim">{state === "offline" ? "—" : info.direct ? "wait at the veil's edge" : "unavailable this time"}</span>
        </div>
      )}
      <p class="note sheet-note">The runner wakes by itself when you seek, and falls asleep after 20 quiet minutes.</p>
      {me.role === "admin" && (
        <div class="stack">
          {state === "offline" && <button class="btn lead" disabled={busy} onClick={() => act(api.wake, "Thinning… I'll tell you when it is open.")}>Wake now</button>}
          {(state === "ready" || state === "booting") && <button class="btn" disabled={busy} onClick={() => act(api.sleep, "The veil is falling.")}>Let it sleep now</button>}
        </div>
      )}
    </SheetFrame>
  );
}

function SettingsSheet({ prefs, onClose, onSaved, open }: { prefs: Prefs; onClose: () => void; onSaved: (p: Prefs) => void; open: (s: Sheet) => void }) {
  const [p, setP] = useState(prefs);
  const save = async (patch: Partial<Prefs>) => {
    setP({ ...p, ...patch });
    try {
      onSaved(await api.prefs(patch));
      haptic.tap();
    } catch {
      toast("The veil did not hear that. Try again.");
    }
  };
  return (
    <SheetFrame title="Settings" onClose={onClose}>
      <div class="field">
        <span>Default format<small>Used when you seek</small></span>
        <div class="seg">
          {(["flac", "mp3", "any"] as const).map((f) => (
            <button class={p.format === f ? "on" : ""} aria-pressed={p.format === f} onClick={() => save({ format: f })}>{f === "any" ? "Any" : f.toUpperCase()}</button>
          ))}
        </div>
      </div>
      <div class="field">
        <span>Largest file<small>{p.max_mb} MB · bigger ones sink to the bottom</small></span>
        <input type="range" min={30} max={500} step={10} value={p.max_mb} aria-label="Largest file in MB"
          onInput={(e) => setP({ ...p, max_mb: Number((e.target as HTMLInputElement).value) })}
          onChange={(e) => save({ max_mb: Number((e.target as HTMLInputElement).value) })} />
      </div>
      <div class="field">
        <span>MP3 320 fallback<small>When no FLAC fits, show MP3 320 first</small></span>
        <input type="checkbox" checked={p.fallback} aria-label="MP3 320 fallback" onChange={(e) => save({ fallback: (e.target as HTMLInputElement).checked })} />
      </div>
      <button class="field link" onClick={() => open("guide")}><span>Guide<small>How veil works, and every command</small></span><span class="dim">›</span></button>
      <button class="field link" onClick={() => open("about")}><span>About veil</span><span class="dim">›</span></button>
    </SheetFrame>
  );
}

function GuideSheet({ onClose }: { onClose: () => void }) {
  const [help, setHelp] = useState<Help | null>(null);
  useEffect(() => {
    api.help().then(setHelp, () => {});
  }, []);
  return (
    <SheetFrame title="Guide" onClose={onClose}>
      {!help ? <p class="note">…</p> : (
        <div class="guide">
          {help.guide.map((s) => (
            <section>
              <h3 class="section">{s.title}</h3>
              {s.body.map((b) => <p>{b}</p>)}
            </section>
          ))}
          <h3 class="section">Commands</h3>
          <dl>
            {help.commands.map((c) => (
              <>
                <dt><code>{c.usage ?? `/${c.command}`}</code>{c.aliases && <span class="dim"> or /{c.aliases.join(", /")}</span>}</dt>
                <dd>{c.help}</dd>
              </>
            ))}
          </dl>
        </div>
      )}
    </SheetFrame>
  );
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <SheetFrame title="veil" onClose={onClose}>
      <div class="guide about">
        <p>A thin, semi-transparent covering that both hides and reveals. It parts just long enough to let a track cross over, then closes again, leaving nothing behind.</p>
        <blockquote>
          Oh could I raise the darken'd veil,<br />
          Which hides my future life from me,<br />
          Could unborn ages slowly sail,<br />
          Before my view—and could I see<br />
          My every action painted there,<br />
          To cast one look I would not dare.
          <cite>Nathaniel Hawthorne, The Spectator</cite>
        </blockquote>
        <p class="dim">No audio is kept, nor your Telegram id. Only a line of text remembers what crossed.</p>
      </div>
    </SheetFrame>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState(false);
  const [state, setState] = useState<SessionState>("offline");
  const [tab, setTab] = useState<Tab>("seek");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [ask, setAsk] = useState<{ query: string; n: number } | null>(null);
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
    const onSheet = (ev: Event) => setSheet((ev as CustomEvent<Sheet>).detail);
    bus.addEventListener("toast", onToast);
    bus.addEventListener("sheet", onSheet);
    return () => {
      stop();
      bus.removeEventListener("toast", onToast);
      bus.removeEventListener("sheet", onSheet);
    };
  }, []);

  if (denied) return <div class="empty">Nothing is here.</div>;
  if (!me) return <div class="empty">…</div>;
  const close = () => setSheet(null);

  return (
    <>
      <Strip state={state} onTap={() => setSheet("session")} />
      {receiveGid ? (
        <Receive gid={receiveGid} />
      ) : (
        <>
          <nav class="tabs" role="tablist">
            {(["seek", "crossings", "beyond"] as const).map((t) => (
              <button role="tab" aria-selected={tab === t} class={tab === t ? "on" : ""} onClick={() => { haptic.tap(); setTab(t); }}>
                {t === "seek" ? "Seek" : t === "crossings" ? "Crossings" : "Beyond"}
              </button>
            ))}
          </nav>
          <div hidden={tab !== "seek"}><Seek prefs={me.prefs} ask={ask} /></div>
          <div hidden={tab !== "crossings"}>
            <Crossings visible={tab === "crossings"} onSeek={(q) => { setTab("seek"); setAsk({ query: q, n: Date.now() }); }} />
          </div>
          {tab === "beyond" && (
            <div class="beyond">
              <p>What lies beyond is still veiled.</p>
              <small>Suggestions drawn from what crossed to you arrive in a later phase.</small>
            </div>
          )}
        </>
      )}
      {sheet === "session" && <SessionSheet me={me} state={state} onClose={close} />}
      {sheet === "settings" && <SettingsSheet prefs={me.prefs} onClose={close} open={setSheet} onSaved={(p) => setMe({ ...me, prefs: p })} />}
      {sheet === "guide" && <GuideSheet onClose={() => setSheet("settings")} />}
      {sheet === "about" && <AboutSheet onClose={() => setSheet("settings")} />}
      {note && <div class="toast" role="status">{note}</div>}
    </>
  );
}

/** If anything throws while rendering, say so and offer a way back instead of freezing. */
function Guard({ children }: { children: ComponentChildren }) {
  const [error, reset] = useErrorBoundary((e) => report(e, "render"));
  if (error) {
    return (
      <div class="empty">
        <p>Something slipped behind the veil.</p>
        <button class="btn lead" onClick={() => { reset(); location.reload(); }}>Try again</button>
      </div>
    );
  }
  return <>{children}</>;
}

watchErrors();
render(<Guard><App /></Guard>, document.getElementById("root")!);
