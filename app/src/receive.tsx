// Direct crossing (docs/DECISIONS.md D8): a file too large for the chat is streamed untouched from the
// runner through the tunnel and saved with Telegram's downloadFile popup (Bot API 8.0).
// Sharing it onward from the page is not possible: Chromium refuses Web Share above 50 MB in total
// (kMaxSharedFileBytes, third_party/blink/renderer/modules/webshare/navigator_share.cc).

import { useEffect, useState } from "preact/hooks";
import { api, mb, type DirectFile } from "./api.ts";
import { haptic, tg } from "./tg.ts";

function FileCard({ f }: { f: DirectFile }) {
  const [state, setState] = useState<"waiting" | "saving" | "saved">("waiting");
  const native = Boolean(tg?.downloadFile && tg.isVersionAtLeast("8.0"));

  const done = async () => {
    setState("saved");
    haptic.ok();
    await api.release(f.job).catch(() => {});
  };

  const save = () => {
    setState("saving");
    if (native) {
      tg!.downloadFile!({ url: f.url, file_name: f.name }, (accepted) => (accepted ? done() : setState("waiting")));
    } else {
      Object.assign(document.createElement("a"), { href: f.url, download: f.name }).click();
      done();
    }
  };

  return (
    <div class="crossing layer" style={{ "--p": state === "saved" ? 50 : 0 }}>
      <div class="half l" />
      <div class="half r" />
      <div class="name">{f.name}</div>
      <div class="text">{state === "saved" ? "Crossed to your device" : `${mb(f.size)} · at the veil's edge`}</div>
      <div class="trace" style={{ "--p": state === "saved" ? 100 : 0 }} />
      <div class="act stack">
        {state !== "saved" ? (
          <button class="btn lead" onClick={save} disabled={state === "saving"}>Save to device</button>
        ) : (
          <p class="note">To keep it in a chat: open the chat, tap 📎 → File, and pick it from your recent files.</p>
        )}
      </div>
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
      <p class="note">Too large for a bot to send into the chat. It waits here, untouched, for 30 minutes.</p>
      <div class="stack">{files.map((f) => <FileCard key={f.job} f={f} />)}</div>
    </section>
  );
}
