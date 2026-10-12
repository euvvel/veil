"""The door: a tiny HTTP server behind the named Cloudflare Tunnel (docs/DECISIONS.md D8).

GET /f/<token> streams a waiting file untouched (Range supported). Unknown paths get 404.
Headers follow core.telegram.org/bots/webapps (downloadFile): Content-Disposition: attachment,
and CORS for web.telegram.org plus the mini app's own origin (for the Web Share path).
"""

import asyncio
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

CHUNK = 256 * 1024
STALL_S = 60  # a reader that accepts nothing for this long is dropped, so it cannot pin a file
TYPES = {"flac": "audio/flac", "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg", "opus": "audio/ogg", "wav": "audio/wav"}


@dataclass
class Waiting:
    path: Path
    name: str
    active: int = 0  # transfers in progress
    served: int = 0  # complete transfers


class Door:
    def __init__(self, port: int, allowed_origins: set[str]):
        self.port = port
        self.allowed = allowed_origins
        self.files: dict[str, Waiting] = {}
        self.server: asyncio.base_events.Server | None = None

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", self.port)

    def offer(self, token: str, path: Path, name: str) -> None:
        self.files[token] = Waiting(path, name)

    def withdraw(self, token: str) -> Waiting | None:
        return self.files.pop(token, None)

    def busy(self, token: str) -> bool:
        w = self.files.get(token)
        return bool(w and w.active)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 15)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        method, target, *_ = (lines[0].split(" ") + ["", ""])[:3]
        headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:] if ":" in ln)}
        origin = headers.get("origin", "")
        cors = [("Access-Control-Allow-Origin", origin), ("Vary", "Origin"), ("Access-Control-Expose-Headers", "Content-Length, Content-Disposition")] if origin in self.allowed else []

        token = target[3:] if target.startswith("/f/") else ""
        w = self.files.get(token)
        try:
            if method == "OPTIONS" and w:
                await self._reply(writer, 204, cors + [("Access-Control-Allow-Methods", "GET, HEAD"), ("Access-Control-Allow-Headers", "Range"), ("Access-Control-Max-Age", "600")])
            elif method in ("GET", "HEAD") and w and w.path.exists():
                await self._serve(writer, method, headers, w, cors)
            else:
                await self._reply(writer, 404, [])
        except (ConnectionError, OSError, asyncio.TimeoutError):
            pass
        finally:
            try:
                writer.transport.abort() if writer.transport.get_write_buffer_size() else writer.close()
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def _reply(self, writer: asyncio.StreamWriter, status: int, headers: list[tuple[str, str]]) -> None:
        reason = {204: "No Content", 404: "Not Found", 416: "Range Not Satisfiable"}.get(status, "OK")
        writer.write(f"HTTP/1.1 {status} {reason}\r\n".encode() + b"".join(f"{k}: {v}\r\n".encode() for k, v in headers) + b"Content-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()

    async def _serve(self, writer, method: str, headers: dict, w: Waiting, cors: list[tuple[str, str]]) -> None:
        size = w.path.stat().st_size
        start, end, status = 0, size - 1, 200
        rng = headers.get("range", "")
        if rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].partition("-")
            try:
                start, end = (int(a), int(b) if b else size - 1) if a else (max(0, size - int(b)), size - 1)
            except ValueError:
                start, end = 0, size - 1
            if start > end or start >= size:
                await self._reply(writer, 416, cors + [("Content-Range", f"bytes */{size}")])
                return
            end = min(end, size - 1)
            status = 206
        ext = w.name.rsplit(".", 1)[-1].lower()
        out = [
            ("Content-Type", TYPES.get(ext, "application/octet-stream")),
            ("Content-Length", str(end - start + 1)),
            ("Content-Disposition", f"attachment; filename=\"{w.name.encode('ascii', 'replace').decode().replace(chr(34), '')}\"; filename*=UTF-8''{quote(w.name)}"),
            ("Accept-Ranges", "bytes"),
            ("Cache-Control", "no-store"),
            *cors,
        ]
        if status == 206:
            out.append(("Content-Range", f"bytes {start}-{end}/{size}"))
        writer.write(f"HTTP/1.1 {status} {'Partial Content' if status == 206 else 'OK'}\r\n".encode()
                     + b"".join(f"{k}: {v}\r\n".encode() for k, v in out) + b"Connection: close\r\n\r\n")
        await writer.drain()
        if method == "HEAD":
            return
        w.active += 1
        try:
            with w.path.open("rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(CHUNK, left))
                    if not chunk:
                        break
                    writer.write(chunk)
                    await asyncio.wait_for(writer.drain(), STALL_S)
                    left -= len(chunk)
            if start == 0 and end == size - 1:
                w.served += 1
        finally:
            w.active -= 1


def allowed_origins(hub_url: str) -> set[str]:
    from urllib.parse import urlsplit

    parts = urlsplit(hub_url)
    return {"https://web.telegram.org", f"{parts.scheme}://{parts.netloc}"}

