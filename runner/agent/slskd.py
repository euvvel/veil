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

    async def search(self, text: str, timeout_ms: int = 15000, response_limit: int = 500, file_limit: int = 25000,
                     snapshot_every_s: float = 5):
        """Run a search and yield (responses, state, done) snapshots while it runs, then once more at the end.

        searchTimeout is in MILLISECONDS. slskd's API description says seconds, but SearchRequest.ToSearchOptions
        passes it unchanged to Soulseek.NET's SearchOptions, which documents milliseconds (default 15000).
        Sending 12 ended every search after 12 ms with 0 results (live, 2026-10-12).
        responseLimit defaults to 100 and fileLimit to 10,000.
        """
        sid = str(uuid.uuid4())
        body = {"id": sid, "searchText": text, "searchTimeout": timeout_ms, "responseLimit": response_limit,
                "fileLimit": file_limit, "filterResponses": True}
        (await self.c.post("/searches", json=body)).raise_for_status()
        state, last_snap, seen = "", time.monotonic(), 0
        deadline = time.monotonic() + timeout_ms / 1000 + 30
        try:
            while time.monotonic() < deadline:
                s = (await self.c.get(f"/searches/{sid}")).json()
                state = s.get("state") or ""
                if s.get("endedAt"):
                    break
                if time.monotonic() - last_snap >= snapshot_every_s and (s.get("responseCount") or 0) > seen:
                    last_snap = time.monotonic()
                    seen = s.get("responseCount") or 0
                    yield (await self.c.get(f"/searches/{sid}/responses")).json(), state, False
                await asyncio.sleep(1)
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
