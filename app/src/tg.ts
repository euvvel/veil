// The parts of Telegram.WebApp veil uses (core.telegram.org/bots/webapps). Outside Telegram it is undefined.

interface BottomButton {
  setParams(p: { text?: string; is_visible?: boolean; is_active?: boolean; color?: string; text_color?: string }): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

export interface WebApp {
  initData: string;
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string | undefined>;
  isVersionAtLeast(v: string): boolean;
  ready(): void;
  expand(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  onEvent(e: string, cb: (...a: unknown[]) => void): void;
  MainButton: BottomButton;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: {
    impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  downloadFile?(p: { url: string; file_name: string }, cb?: (accepted: boolean) => void): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  showAlert(msg: string, cb?: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

export const tg: WebApp | undefined = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : undefined;

export const haptic = {
  tap: () => tg?.HapticFeedback.selectionChanged(),
  soft: () => tg?.HapticFeedback.impactOccurred("soft"),
  ok: () => tg?.HapticFeedback.notificationOccurred("success"),
  fail: () => tg?.HapticFeedback.notificationOccurred("error"),
};

export const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Follow Telegram's light/dark scheme, but keep veil's own field so Telegram's frame dissolves into it. */
export function applyTheme(): void {
  const scheme = tg?.colorScheme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = scheme;
  if (tg) {
    tg.setHeaderColor(token("--void"));
    tg.setBackgroundColor(token("--void"));
  }
}
