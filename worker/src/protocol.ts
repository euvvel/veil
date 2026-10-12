// Mirror of protocol/PROTOCOL.md (v1).

export type Fmt = "flac" | "mp3" | "any";

/** [path, size, ext, bitRate, bitDepth, sampleRate, lengthSec] */
export type WireFile = [string, number, string, number | null, number | null, number | null, number | null];

export interface Folder {
  u: string;
  d: string;
  f: boolean;
  q: number;
  s: number;
  files: WireFile[];
}

export type JobState = "pending" | "queued" | "downloading" | "uploading" | "awaiting" | "delivered" | "failed";
export type JobMode = "chat" | "direct";
export const TERMINAL: JobState[] = ["delivered", "failed"];

export interface TrackMeta {
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  year?: number | null;
  format?: string | null;
  bitrate?: number | null;
  mb_recording?: string | null;
  mb_release?: string | null;
  message_id?: number | null;
}

export interface JobStateMsg {
  job_id: string;
  state: JobState;
  pct?: number;
  place?: number;
  kbps?: number;
  error?: string;
  token?: string; // awaiting: one-time token for the direct link
  track?: TrackMeta;
}

export interface Envelope<T = Record<string, unknown>> {
  v: 1;
  type: string;
  ts?: number;
  data?: T;
}

export const frame = (type: string, data: Record<string, unknown> = {}) => JSON.stringify({ v: 1, type, ts: Date.now(), data });
