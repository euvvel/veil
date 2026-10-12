"""Diagnostic: run the agent's real search against Soulseek and print counts only (public logs)."""

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from agent.__main__ import build_folders  # noqa: E402
from agent.slskd import Slskd  # noqa: E402


async def main() -> None:
    s = Slskd("http://127.0.0.1:5030", os.environ["SLSKD_API_KEY"])
    if not await s.wait_logged_in():
        print("[check] login failed")
        return
    for n, q in enumerate(q for q in os.environ["SPIKE_QUERIES"].splitlines() if q.strip()):
        t0 = time.monotonic()
        async for responses, state, done in s.search(q.strip()):
            files = sum(len(r.get("files") or []) for r in responses)
            folders = build_folders(responses)
            print(f"[check] query {n + 1}: t={time.monotonic() - t0:4.1f}s {'final  ' if done else 'partial'} "
                  f"peers={len(responses)} files={files} folders_sent={len(folders)} state={state}", flush=True)


asyncio.run(main())
