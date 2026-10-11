// Minimal Bot API client. Failures are returned, never thrown: a lost status edit must not break the Hub.

export interface TgResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

export async function tgCall<T = unknown>(token: string, method: string, body: unknown): Promise<TgResult<T>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as TgResult<T>;
  } catch {
    return { ok: false, description: "network" };
  }
}
