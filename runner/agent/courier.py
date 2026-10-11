"""Delivers files to Telegram through the courier bot, and reads text tags first."""

from pathlib import Path

import httpx
import mutagen

AUDIO_PLAYER = {"mp3", "m4a"}  # Bot API: sendAudio takes MP3/M4A; everything else goes as a document


class CourierError(Exception):
    def __init__(self, category: str):
        super().__init__(category)
        self.category = category


def read_tags(path: Path) -> dict:
    """Text metadata only. Missing tags are fine."""
    out: dict = {"format": path.suffix.lstrip(".").lower() or None}
    try:
        f = mutagen.File(path, easy=True)
    except Exception:
        return out
    if f is None:
        return out
    tags = f.tags or {}

    def first(key: str):
        try:
            v = tags.get(key)
        except Exception:
            return None
        return (v[0] if isinstance(v, list) and v else v) or None

    year = first("date") or first("originaldate")
    out.update(
        artist=first("artist") or first("albumartist"),
        title=first("title"),
        album=first("album"),
        year=int(year[:4]) if year and year[:4].isdigit() else None,
        mb_recording=first("musicbrainz_trackid"),
        mb_release=first("musicbrainz_albumid"),
        bitrate=(getattr(f.info, "bitrate", 0) or 0) // 1000 or None,
    )
    return out


class Courier:
    def __init__(self, token: str, api_base: str = "https://api.telegram.org", max_upload_mb: int = 50):
        self.url = f"{api_base.rstrip('/')}/bot{token}"
        self.max_bytes = max_upload_mb * 1024 * 1024
        self.c = httpx.AsyncClient(timeout=httpx.Timeout(30, write=600, read=600))

    async def send(self, chat_id: int, path: Path, caption: str, tags: dict) -> int:
        if path.stat().st_size > self.max_bytes:
            raise CourierError("too_large")
        ext = path.suffix.lstrip(".").lower()
        method, field = ("sendAudio", "audio") if ext in AUDIO_PLAYER else ("sendDocument", "document")
        data: dict = {"chat_id": str(chat_id), "caption": caption[:1024]}
        if method == "sendAudio":
            if tags.get("artist"):
                data["performer"] = tags["artist"]
            if tags.get("title"):
                data["title"] = tags["title"]
        try:
            with path.open("rb") as fh:
                res = await self.c.post(f"{self.url}/{method}", data=data, files={field: (path.name, fh)})
            body = res.json()
        except (httpx.HTTPError, ValueError) as e:
            raise CourierError("upload") from e
        if not body.get("ok"):
            raise CourierError("upload")
        return body["result"]["message_id"]
