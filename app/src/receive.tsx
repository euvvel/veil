// Direct crossing (docs/DECISIONS.md D8): a file too large for the chat is streamed untouched from the
// runner through the tunnel. "Put it in the chat" hands it to the user's own Telegram app via Web Share;
// "Save to device" uses Telegram's downloadFile popup (Bot API 8.0).

import { useEffect, useState } from "preact/hooks";
import { api, mb, type DirectFile } from "./api.ts";
import { toast } from "./main.tsx";
import { haptic, tg } from "./tg.ts";

const TYPES: Record<string, string> = { flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" };
const typeOf = (name: string) => TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["x"], "x.flac", { type: "audio/flac" })] });
  } catch {
    return false;
  }
}

function FileCard({ f }: { f: DirectFile }) {
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const share = canShareFiles();
  const download = Boolean(tg?.downloadFile && tg.isVersionAtLeast("8.0"));

  const finish = async () => {
    setDone(true);
    haptic.ok();
    await api.release(f.job).catch(() => {});
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
      toast("It slipped back behind the veil. Try again, or save it to the device.");
    }
  };

  const putInChat = async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: f.name });
      await finish();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast("This device would not share it. Save it to the device instead.");
    }
  };

  const save = () => {
    if (download) {
      tg!.downloadFile!({ url: f.url, file_name: f.name }, (accepted) => accepted && finish());
    } else {
      window.open(f.url, "_blank");
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
      <div class="stack">{files.map((f) => <FileCard key={f.job} f={f} />)}</div>
    </section>
  );
}
