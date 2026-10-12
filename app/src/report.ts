// Report client errors to the Worker log (message and a short stack only), so real-device failures are visible.
// Long digit runs are masked, so an id that slipped into a message never reaches the log.

let sent = 0;

export function report(error: unknown, where: string): void {
  if (sent >= 5) return;
  sent += 1;
  const e = error instanceof Error ? error : new Error(String(error));
  const clean = (s: string | undefined, n: number) => (s ?? "").replace(/\d{6,}/g, "#").slice(0, n);
  const body = JSON.stringify({ where, message: clean(e.message, 300), stack: clean(e.stack, 800) });
  const tma = window.Telegram?.WebApp?.initData ?? "";
  fetch("/api/client-error", { method: "POST", headers: { Authorization: `tma ${tma}`, "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
}

export function watchErrors(): void {
  addEventListener("error", (ev) => {
    // "Script error." is all a browser reveals about a failure inside a cross-origin script (Telegram's SDK);
    // it carries nothing to act on, so it is not reported.
    if (!ev.error && /^Script error\.?$/.test(ev.message)) return;
    report(ev.error ?? ev.message, "window");
  });
  addEventListener("unhandledrejection", (ev) => report(ev.reason, "promise"));
}
