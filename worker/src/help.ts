// The one source of truth for veil's commands and help text.
// Used by: the bot (/help, /start, per-chat command menus), the mini app Guide (GET /api/help),
// and test/help.test.ts, which fails if docs/GUIDE.md leaves a command out.

import type { Role } from "./members.ts";

export interface Command {
  command: string; // without the slash
  menu: string; // short description for Telegram's command menu (≤ 256 chars)
  usage?: string; // how to call it, if it takes arguments
  help: string; // one or two sentences for /help and the Guide
  roles: Role[];
  aliases?: string[];
}

export const COMMANDS: Command[] = [
  {
    command: "seek",
    aliases: ["s"],
    usage: "/seek [flac|mp3|any] words",
    menu: "Seek a track or album",
    help: "Searches Soulseek. Start with flac, mp3 or any to choose the format; without words it repeats your last search. Results come with page buttons and FLAC · MP3 · Any / Tracks · Albums toggles.",
    roles: ["admin", "member"],
  },
  {
    command: "beyond",
    menu: "What lies beyond: suggestions",
    help: "This week's suggestions, drawn from what crossed to you and checked against MusicBrainz. Tap a number to seek it.",
    roles: ["admin", "member"],
  },
  {
    command: "history",
    menu: "Your last crossings",
    help: "Lists the last ten tracks that crossed to you, as text: artist, title, format.",
    roles: ["admin", "member"],
  },
  {
    command: "status",
    menu: "Is the veil open?",
    help: "Shows whether the runner is closed, starting, open or falling. Seeking starts it by itself.",
    roles: ["admin", "member"],
  },
  {
    command: "help",
    menu: "How veil works",
    help: "This guide.",
    roles: ["admin", "member"],
  },
  {
    command: "wake",
    menu: "Part the veil now",
    help: "Starts the runner without searching, and tells you when it is open.",
    roles: ["admin"],
  },
  {
    command: "sleep",
    menu: "Let the veil fall now",
    help: "Asks the runner to finish what it is sending, log out of Soulseek and stop. It also stops by itself after 20 quiet minutes.",
    roles: ["admin"],
  },
  {
    command: "invite",
    menu: "Let someone through, once",
    help: "Creates a single-use invite link, valid for 24 hours. Send it only to someone you trust.",
    roles: ["admin"],
  },
  {
    command: "members",
    menu: "Who may cross",
    help: "Lists members (by a short fingerprint, never a Telegram id) with buttons to revoke them.",
    roles: ["admin"],
  },
  {
    command: "leave",
    menu: "Be forgotten",
    help: "Removes you from veil. You would need a new invite to return.",
    roles: ["member"],
  },
];

export interface HelpSection {
  title: string;
  body: string[];
}

/** Prose for /help and the Guide, beyond the command list. Kept short on purpose. */
export const GUIDE: HelpSection[] = [
  {
    title: "Seeking",
    body: [
      "Just type what you are looking for (artist, album, title), or use /seek. veil listens until Soulseek's answers settle, usually five to seven seconds, and gathers up to a thousand people's answers.",
      "Tracks are single files; Albums are whole folders from one person. FLAC comes first by default; when no FLAC fits your size limit, MP3 320 is offered first instead.",
    ],
  },
  {
    title: "Crossing",
    body: [
      "Choose a result and let it cross. The file comes to you from @{courier}, untouched, and is deleted from the runner the moment it arrives.",
      "If a person refuses or goes quiet, veil tries the same file from someone else, up to three times.",
      "Files over 50 MB are too large for a bot to send. They wait at the veil's edge for 30 minutes: open veil and save them to your device.",
    ],
  },
  {
    title: "Beyond",
    body: [
      "Suggestions drawn from what crossed to you: more like it, more from the same hand, quieter records near your taste, a weekly mix, and a rabbit hole that walks outward from any artist.",
      "Every suggestion is a real release confirmed against MusicBrainz; the AI only orders them and writes the one-line reasons. Tapping one seeks it; ✕ skips it for good and teaches the veil.",
    ],
  },
  {
    title: "The runner",
    body: [
      "veil wakes a short-lived runner when you seek. It is usually open in under half a minute, and falls asleep after 20 quiet minutes, logging out of Soulseek. Nothing is kept: only a line of text remembers what crossed.",
    ],
  },
];

export const commandsFor = (role: Role) => COMMANDS.filter((c) => c.roles.includes(role));

/** Telegram command menu entries for a role. */
export const menuFor = (role: Role) => commandsFor(role).map((c) => ({ command: c.command, description: c.menu }));

/** Changes whenever the menu would change, so member menus can refresh themselves. */
export const MENU_VERSION = (() => {
  let h = 5381;
  for (const ch of JSON.stringify(COMMANDS.map((c) => [c.command, c.menu, c.roles]))) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
})();

/** Plain-text /help for a role. */
export function helpText(role: Role, courier: string): string {
  const cmds = commandsFor(role)
    .map((c) => `${c.usage ?? `/${c.command}`}${c.aliases ? `  (or /${c.aliases.join(", /")})` : ""}\n  ${c.help}`)
    .join("\n\n");
  const prose = GUIDE.map((s) => `${s.title.toUpperCase()}\n${s.body.join("\n")}`).join("\n\n").replaceAll("{courier}", courier);
  return `veil · help\n\n${prose}\n\nCOMMANDS\n${cmds}\n\nOr open veil from the button beside the message field.`;
}
