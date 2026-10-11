// WebCrypto helpers. Work in Workers and in Node 22 (globalThis.crypto).

const enc = new TextEncoder();

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmac(key: string | ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

export async function hmacHex(key: string | ArrayBuffer, msg: string): Promise<string> {
  return hex(await hmac(key, msg));
}

export async function sha256Hex(msg: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(msg)));
}

export function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer);
}

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
