// veil vocabulary (docs/DESIGN.md): the veil label first, the plain label beside it.

import type { SessionState } from "./session.ts";

export const sessionLabel: Record<SessionState, [veil: string, plain: string]> = {
  offline: ["The veil is closed", "Runner off"],
  booting: ["Thinning…", "Starting"],
  ready: ["The veil is open", "Connected"],
  draining: ["The veil is falling", "Shutting down"],
};

export const label = (s: SessionState) => `${sessionLabel[s][0]} · ${sessionLabel[s][1]}`;
