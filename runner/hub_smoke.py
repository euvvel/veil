"""Phase 2 smoke runner: connect to the Hub, say hello, heartbeat, then leave cleanly.

Phase 3 replaces this with the real agent (slskd + courier). Prints states only.
"""

import asyncio
import json
import os
import time

from websockets.asyncio.client import connect

HEARTBEAT_S = 30


def envelope(type_: str, **data) -> str:
    return json.dumps({"v": 1, "type": type_, "ts": int(time.time() * 1000), "data": data})


async def main() -> None:
    base = os.environ["HUB_URL"].rstrip("/")
    url = base.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/hub/runner"
    stay = int(os.environ.get("STAY_S", "120"))
    async with connect(url, additional_headers={"Authorization": f"Bearer {os.environ['RUNNER_SECRET']}"}) as ws:
        await ws.send(envelope("runner.hello", run_id=int(os.environ.get("GITHUB_RUN_ID", "0")),
                               session_id=os.environ.get("SESSION_ID") or None, agent="hub-smoke/1"))
        welcome = json.loads(await asyncio.wait_for(ws.recv(), 10))
        print(f"[runner] {welcome['type']}: {welcome['data']['state']}", flush=True)

        end = time.monotonic() + stay
        while time.monotonic() < end:
            await asyncio.sleep(min(HEARTBEAT_S, max(0, end - time.monotonic())))
            await ws.send(envelope("runner.heartbeat"))
            print("[runner] heartbeat", flush=True)

        await ws.send(envelope("session.state", state="draining"))
        await asyncio.sleep(1)
        await ws.send(envelope("runner.bye"))
        print("[runner] bye", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
