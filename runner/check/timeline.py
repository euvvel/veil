"""Diagnostic: how fast do Soulseek answers arrive? Prints the response count per second (counts only)."""

import asyncio
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from agent.slskd import Slskd  # noqa: E402


async def main() -> None:
    s = Slskd("http://127.0.0.1:5030", os.environ["SLSKD_API_KEY"])
    if not await s.wait_logged_in():
        print("[check] login failed")
        return
    queries = [q.strip() for q in os.environ["SPIKE_QUERIES"].splitlines() if q.strip()]
    queries += [q.strip() for q in os.environ.get("EXTRA_QUERIES", "").split("|") if q.strip()]
    for n, q in enumerate(queries):
        sid = str(uuid.uuid4())
        await s.c.post("/searches", json={"id": sid, "searchText": q, "searchTimeout": 25000, "responseLimit": 1000, "fileLimit": 100000})
        t0, marks = time.monotonic(), []
        while time.monotonic() - t0 < 30:
            st = (await s.c.get(f"/searches/{sid}")).json()
            marks.append(f"{time.monotonic() - t0:.0f}s:{st.get('responseCount', 0)}/{st.get('fileCount', 0)}")
            if st.get("endedAt"):
                break
            await asyncio.sleep(1)
        await s.c.delete(f"/searches/{sid}")
        print(f"[check] query {n + 1}: " + " ".join(marks), flush=True)


asyncio.run(main())
