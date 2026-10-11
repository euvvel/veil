"""The runner's link to the Hub (protocol/PROTOCOL.md). Reconnects with backoff; queued frames survive drops."""

import asyncio
import collections
import json
import time
from typing import Awaitable, Callable

from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException


def frame(type_: str, **data) -> str:
    return json.dumps({"v": 1, "type": type_, "ts": int(time.time() * 1000), "data": data})


class HubLink:
    def __init__(self, url: str, secret: str, hello: Callable[[], dict], on_message: Callable[[dict], Awaitable[None]]):
        base = url.rstrip("/")
        self.url = base.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/hub/runner"
        self.headers = {"Authorization": f"Bearer {secret}"}
        self.hello = hello
        self.on_message = on_message
        self.outbox: collections.deque[str] = collections.deque()
        self.wake = asyncio.Event()
        self.connected = asyncio.Event()

    def send(self, type_: str, **data) -> None:
        self.outbox.append(frame(type_, **data))
        self.wake.set()

    async def flushed(self, timeout_s: float = 10) -> None:
        deadline = time.monotonic() + timeout_s
        while self.outbox and time.monotonic() < deadline:
            await asyncio.sleep(0.2)

    async def run(self, stop: asyncio.Event) -> None:
        backoff = 1
        while not stop.is_set():
            try:
                async with connect(self.url, additional_headers=self.headers, max_size=4 * 1024 * 1024) as ws:
                    await ws.send(frame("runner.hello", **self.hello()))
                    self.connected.set()
                    backoff = 1
                    print("[agent] hub connected", flush=True)
                    reader = asyncio.create_task(self._read(ws))
                    writer = asyncio.create_task(self._write(ws))
                    stopper = asyncio.create_task(stop.wait())
                    await asyncio.wait({reader, writer, stopper}, return_when=asyncio.FIRST_COMPLETED)
                    for t in (reader, writer, stopper):
                        t.cancel()
            except (OSError, WebSocketException, asyncio.TimeoutError):
                pass
            self.connected.clear()
            if stop.is_set():
                break
            print(f"[agent] hub link lost, retrying in {backoff}s", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _read(self, ws) -> None:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            await self.on_message(msg)

    async def _write(self, ws) -> None:
        while True:
            while self.outbox:
                await ws.send(self.outbox[0])
                self.outbox.popleft()  # only after a successful send
            self.wake.clear()
            await self.wake.wait()
