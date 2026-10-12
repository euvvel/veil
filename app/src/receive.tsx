// Direct crossing (docs/DECISIONS.md D8): a file too large for the chat is streamed untouched from the
// runner through the tunnel. Paths, best first:
//   1. "Put it in the chat": Web Share hands the file to the user's own Telegram app.
//   2. "Open in browser…": where Telegram's own web view cannot share files (Android), the phone's browser can.
//   3. "Save to device": Telegram's downloadFile popup (Bot API 8.0).

import { useEffect, useState } from "preact/hooks";
import { api, mb, type DirectFile } from "./api.ts";
import { toast } from "./main.tsx";
import { haptic, tg } from "./tg.ts";

const TYPES: Record<string, string> = { flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" };
const typeOf = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["x"], "x.flac", { type: "audio/flac" })] });
  } catch {
    return false;
  }
}

/** The door link outside Telegram: everything after `#` stays in the browser and never reaches a server log. */
export const outLink = (f: DirectFile) =>
  `${location.origin}/#out?${new URLSearchParams({ u: f.url, n: f.name, s: String(f.size) })}`;

type Where = "telegram" | "browser";

export function FileCard({ f, where, onDone }: { f: DirectFile; where: Where; onDone: () => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const share = canShareFiles();
  const download = where === "telegram" && Boolean(tg?.downloadFile && tg.isVersionAtLeast("8.0"));

  const finish = async () => {
    setDone(true);
    haptic.ok();
    await onDone().catch(() => {});
  };

  const bringClose = async () => {
    setPct(0);
    try {
      const res = await fetch(f.url);
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
      const total = Number(res.headers.get("Content-Length")) || f.size;
      const reader = res.body.getReader();
      const parts: BlobPart[] = [];
      let got = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value);
        got += value.length;
        setPct(Math.round((got / total) * 100));
      }
      setFile(new File(parts, f.name, { type: typeOf(f.name) }));
      haptic.soft();
    } catch {
      setPct(null);
      haptic.fail();
      toast("It slipped back behind the veil. Try again.");
    }
  };

  const putInChat = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: f.name });
      await finish();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast("This device would not share it. Save it instead.");
    }
  };

  const save = () => {
    if (download) tg!.downloadFile!({ url: f.url, file_name: f.name }, (accepted) => accepted && finish());
    else {
      const a = Object.assign(document.createElement("a"), { href: f.url, download: f.name });
      a.click();
      finish();
    }
  };

  return (
    <div class="crossing layer" style={{ "--p": done ? 50 : (pct ?? 0) / 2 }}>
      <div class="half l" />
      <div class="half r" />
      <div class="name">{f.name}</div>
      <div class="text">{done ? "Crossed" : `${mb(f.size)} · at the veil's edge`}</div>
      <div class="ember" style={{ "--p": done ? 100 : pct ?? 0 }} />
      {!done && (
        <div class="act stack">
          {share && !file && (
            <button class="btn ember" onClick={bringClose} disabled={pct !== null}>
              {pct === null ? "Bring it close" : `Bringing it close · ${pct}%`}
            </button>
          )}
          {share && file && <button class="btn ember" onClick={putInChat}>Put it in the chat</button>}
          {!share && where === "telegram" && (
            <>
              <button class="btn ember" onClick={() => tg?.openLink(outLink(f), { try_instant_view: false })}>Open in browser to put it in the chat</button>
              <p class="note">Telegram's window here cannot hand files to other apps. Your browser can.</p>
            </>
          )}
          <button class="btn" onClick={save}>Save to device</button>
        </div>
      )}
    </div>
  );
}

export function Receive({ gid }: { gid: string }) {
  const [files, setFiles] = useState<DirectFile[] | null>(null);
  useEffect(() => {
    api.direct(gid).then(setFiles, () => setFiles([]));
    const back = () => {
      location.hash = "";
      location.reload();
    };
    tg?.BackButton.show();
    tg?.BackButton.onClick(back);
    return () => tg?.BackButton.offClick(back);
  }, [gid]);

  if (!files) return <div class="empty">…</div>;
  if (files.length === 0) return <div class="empty">Nothing waits at the veil's edge.</div>;
  return (
    <section>
      <p class="note">Too large to cross into the chat on its own. It waits here, untouched, for 30 minutes.</p>
      <div class="stack">
        {files.map((f) => <FileCard key={f.job} f={f} where="telegram" onDone={() => api.release(f.job).then(() => {})} />)}
      </div>
    </section>
  );
}

/** The page opened in the phone's browser. It holds only the door link (from the hash), no login. */
export function Out() {
  const q = new URLSearchParams(location.hash.replace(/^#out\?/, ""));
  const url = q.get("u") ?? "";
  const f: DirectFile = { job: "", url, name: q.get("n") ?? "file", size: Number(q.get("s")) || 0 };
  const token = url.split("/f/")[1] ?? "";
  if (!url.startsWith("https://") || !token) return <div class="empty">Nothing waits at the veil's edge.</div>;
  const release = () =>
    fetch("/out/release", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token }) }).then(() => {});
  return (
    <section>
      <header class="strip"><span class="mist ready" aria-hidden="true" /><span class="veil">At the veil's edge</span></header>
      <p class="note" style={{ marginTop: "18px" }}>
        {canShareFiles()
          ? "Bring it close, then put it in the chat: choose Telegram in the share sheet, then the chat."
          : "This browser cannot hand files to other apps. Save it, then send it from your files."}
      </p>
      <FileCard f={f} where="browser" onDone={release} />
    </section>
  );
}
