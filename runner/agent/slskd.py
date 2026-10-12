"""Thin async client for the slskd REST API (shapes: runner/reference/slskd-0.26.1-openapi.json)."""

import asyncio
import time
import uuid
from urllib.parse import quote

import httpx


class Slskd:
    def __init__(self, base: str, api_key: str):
        self.c = httpx.AsyncClient(base_url=f"{base.rstrip('/')}/api/v0", headers={"X-API-Key": api_key}, timeout=30)

    async def wait_logged_in(self, timeout_s: float = 90) -> bool:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                if (await self.c.get("/server")).json().get("isLoggedIn"):
                    return True
            except (httpx.HTTPError, ValueError):
                pass
            await asyncio.sleep(1)
        return False

    async def search(self, text: str, on_progress=None, settle_s: float = 1.5, min_s: float = 2.5, cap_s: float = 6,
                     response_limit: int = 1000, file_limit: int = 60000):
        """Run a search, stop it once answers settle, and yield (responses, state, done=True) once.

        Measured live (check-search timeline, 2026-10-12): about 98% of answers arrive within 3-4 s;
        waiting 15-28 s only adds stragglers (784 → 798, 182 → 184, 286 → 291 peers).
        So: after `min_s`, stop as soon as the count grew by under 1% (or not at all) over the last `settle_s`;
        popular queries keep a trickle of ~1 answer/s that would otherwise run to `cap_s`. Never wait past `cap_s`.
        Stopping is slskd's Cancel (PUT /searches/{id}), which keeps every response.

        searchTimeout is in MILLISECONDS and counts from the last answer (Soulseek.NET); slskd's API description
        says seconds but passes the value through unchanged. It is set long here: our own rule decides.
        slskd exposes responses only after a search ends, so progress is reported as counts (on_progress).
        """
        sid = str(uuid.uuid4())
        body = {"id": sid, "searchText": text, "searchTimeout": int((cap_s + 5) * 1000), "responseLimit": response_limit,
                "fileLimit": file_limit, "filterResponses": True}
        (await self.c.post("/searches", json=body)).raise_for_status()
        state, started, stopped = "", time.monotonic(), False
        last_count, history = 0, []  # (time, count)
        try:
            while time.monotonic() - started < cap_s + 15:
                s = (await self.c.get(f"/searches/{sid}")).json()
                state = s.get("state") or ""
                if s.get("endedAt"):
                    break
                now, count = time.monotonic(), s.get("responseCount") or 0
                if count != last_count:
                    last_count = count
                    if on_progress:
                        on_progress(count, s.get("fileCount") or 0)
                history.append((now, count))
                before = next((c for ts, c in reversed(history) if now - ts >= settle_s), None)
                settled = before is not None and count - before <= max(1, count // 100)
                elapsed = now - started
                if not stopped and (elapsed >= cap_s or (elapsed >= min_s and settled)):
                    await self.c.put(f"/searches/{sid}")
                    stopped = True
                await asyncio.sleep(0.4)
            yield (await self.c.get(f"/searches/{sid}/responses")).json(), state, True
        finally:
            await self.c.delete(f"/searches/{sid}")

    async def enqueue(self, job_id: str, username: str, path: str, size: int) -> tuple[str | None, int]:
        batch_id = str(uuid.uuid4())
        body = {"id": batch_id, "username": username, "files": [{"filename": path, "size": size}], "options": {"externalId": job_id}}
        res = await self.c.post("/transfers/downloads/batches", json=body)
        return (batch_id if res.status_code in (200, 201) else None), res.status_code

    async def transfer(self, batch_id: str) -> dict | None:
        res = await self.c.get(f"/transfers/downloads/batches/{batch_id}")
        if res.status_code != 200:
            return None
        transfers = res.json().get("transfers") or []
        return transfers[0] if transfers else None

    async def refresh_position(self, username: str, transfer_id: str) -> None:
        await self.c.get(f"/transfers/downloads/{quote(username, safe='')}/{transfer_id}/position")

    async def cancel(self, username: str, transfer_id: str) -> None:
        await self.c.delete(f"/transfers/downloads/{quote(username, safe='')}/{transfer_id}", params={"remove": "true"})

    async def logout(self) -> int:
        res = await self.c.request("DELETE", "/server", json="the veil falls")
        return res.status_code
