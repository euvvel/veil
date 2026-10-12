"""veil runner agent: slskd ⇄ Hub ⇄ courier. Public logs: counts and states only.

Env: HUB_URL, RUNNER_SECRET, SLSKD_URL, SLSKD_API_KEY, DL_DIR, COURIER_BOT_TOKEN,
     [COURIER_API_BASE, MAX_UPLOAD_MB, SESSION_ID, GITHUB_RUN_ID, IDLE_S, MAX_S, DELETE_CMD,
      DIRECT_BASE, DOOR_PORT]  (DIRECT_BASE: public https URL of the named tunnel, D8)
"""

import asyncio
import os
import secrets
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from .courier import Courier, CourierError, read_tags
from .door import Door, allowed_origins
from .hub import HubLink
from .slskd import Slskd

AUDIO = {"flac", "mp3", "m4a", "ogg", "opus", "wav", "aac", "alac"}
POLL_S = 2
PROGRESS_EVERY_S = 2
POSITION_EVERY_S = 30
HEARTBEAT_S = 30
MAX_FOLDERS, MAX_FILES = 25, 25
AWAIT_S = 30 * 60  # how long a direct file waits at the veil's edge
RELEASE_GRACE_S = 90  # after release, give a just-accepted download time to start


def log(msg: str) -> None:
    print(f"[agent] {msg}", flush=True)


def ext_of(f: dict) -> str:
    ext = (f.get("extension") or "").lower().lstrip(".")
    return ext or f["filename"].rsplit(".", 1)[-1].lower()


def split_dir(path: str) -> str:
    sep = "\\" if "\\" in path else "/"
    return path.rsplit(sep, 1)[0] if sep in path else ""


def failure_category(exc: str | None, state: str) -> str:
    text = (exc or "").lower()
    for needle, cat in [("connection", "connect"), ("timed out", "timeout"), ("timeout", "timeout"), ("rejected", "rejected"),
                        ("banned", "rejected"), ("queue", "queue"), ("not shared", "not_shared"), ("file not", "not_shared")]:
        if needle in text:
            return cat
    if "Cancelled" in state:
        return "cancelled"
    if "TimedOut" in state:
        return "timeout"
    if "Rejected" in state:
        return "rejected"
    return "unknown"


def build_folders(responses: list[dict]) -> list[dict]:
    groups: dict[tuple[str, str], dict] = {}
    for r in responses:
        for f in r.get("files") or []:
            ext = ext_of(f)
            if ext not in AUDIO:
                continue
            key = (r["username"], split_dir(f["filename"]))
            g = groups.setdefault(key, {"u": key[0], "d": key[1], "f": bool(r.get("hasFreeUploadSlot")),
                                        "q": r.get("queueLength") or 0, "s": r.get("uploadSpeed") or 0, "files": []})
            g["files"].append([f["filename"], f["size"], ext, f.get("bitRate"), f.get("bitDepth"), f.get("sampleRate"), f.get("length")])
    ranked = sorted(groups.values(), key=lambda g: (not g["f"], g["q"], -g["s"]))
    has = lambda g, e: any(x[2] == e for x in g["files"])  # noqa: E731
    picked: list[dict] = []
    for subset in ([g for g in ranked if has(g, "flac")][:13], [g for g in ranked if has(g, "mp3")][:13], ranked[:6]):
        for g in subset:
            if g not in picked and len(picked) < MAX_FOLDERS:
                picked.append(g)
    for g in picked:
        g["files"] = sorted(g["files"], key=lambda x: x[0])[:MAX_FILES]
    return picked


@dataclass
class Job:
    id: str
    peer: str
    path: str
    size: int
    chat_id: int
    caption: str
    mode: str = "chat"
    batch_id: str | None = None
    transfer_id: str | None = None
    token: str | None = None
    local: Path | None = None
    tags: dict | None = None
    offered_at: float = 0
    released_at: float = 0
    state: str = "queued"
    pct: float = 0
    last_sent: float = 0
    last_position: float = 0
    task: asyncio.Task | None = field(default=None, repr=False)


class Agent:
    def __init__(self) -> None:
        e = os.environ
        self.slskd = Slskd(e.get("SLSKD_URL", "http://127.0.0.1:5030"), e["SLSKD_API_KEY"])
        self.max_upload_mb = int(e.get("MAX_UPLOAD_MB", "50"))
        self.courier = Courier(e["COURIER_BOT_TOKEN"], e.get("COURIER_API_BASE", "https://api.telegram.org"), self.max_upload_mb)
        self.dl_dir = Path(e["DL_DIR"])
        self.delete_cmd = shlex.split(e.get("DELETE_CMD", ""))  # e.g. "sudo rm -f" when slskd writes as root
        self.idle_s = int(e.get("IDLE_S", "1200"))
        self.max_s = int(e.get("MAX_S", "19800"))
        self.started = time.monotonic()
        self.last_activity = time.monotonic()
        self.jobs: dict[str, Job] = {}
        self.searching = 0
        self.stop = asyncio.Event()
        self.draining = False
        self.direct_base = (e.get("DIRECT_BASE") or "").rstrip("/")
        self.door = Door(int(e.get("DOOR_PORT", "8090")), allowed_origins(e["HUB_URL"])) if self.direct_base else None
        self.link = HubLink(e["HUB_URL"], e["RUNNER_SECRET"], self.hello, self.on_message)

    def hello(self) -> dict:
        return {"run_id": int(os.environ.get("GITHUB_RUN_ID", "0")), "session_id": os.environ.get("SESSION_ID") or None,
                "agent": "veil-agent/1", "active_jobs": list(self.jobs), "max_upload_mb": self.max_upload_mb,
                "direct_base": self.direct_base or None}

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def report(self, job: Job, state: str, **extra) -> None:
        job.state = state
        job.last_sent = time.monotonic()
        self.link.send("job.state", job_id=job.id, state=state, **extra)
        self.touch()

    # ------------------------------------------------------------ hub messages

    async def on_message(self, msg: dict) -> None:
        t, d = msg.get("type"), msg.get("data") or {}
        if t == "search.start" and not self.draining:
            asyncio.create_task(self.run_search(d["search_id"], d["query"]))
        elif t == "job.start" and not self.draining and d["job_id"] not in self.jobs:
            job = Job(d["job_id"], d["peer"], d["path"], int(d["size"]), int(d["chat_id"]), d.get("caption") or "", mode=d.get("mode") or "chat")
            if job.mode == "direct" and not self.door:
                self.report(job, "failed", error="too_large")
                return
            self.jobs[job.id] = job
            await self.start_job(job)
        elif t == "job.release" and d.get("job_id") in self.jobs:
            job = self.jobs[d["job_id"]]
            if job.state == "awaiting" and not job.released_at:
                job.released_at = time.monotonic()
        elif t == "job.cancel" and d.get("job_id") in self.jobs:
            job = self.jobs.pop(d["job_id"])
            if job.transfer_id:
                await self.slskd.cancel(job.peer, job.transfer_id)
            self.report(job, "failed", error="cancelled")
        elif t == "session.drain":
            asyncio.create_task(self.drain("asked"))

    # ------------------------------------------------------------ searches

    async def run_search(self, search_id: str, query: str) -> None:
        self.searching += 1
        self.touch()
        try:
            responses, state = await self.slskd.search(query)
            folders = build_folders(responses)
            files = sum(len(r.get("files") or []) for r in responses)
            self.link.send("search.results", search_id=search_id, responses=len(responses), files=files, folders=folders)
            log(f"search done: {len(responses)} peers, {files} files, {len(folders)} folders sent ({state})")
        except Exception as e:  # noqa: BLE001 - a failed search must not kill the agent
            log(f"search failed: {type(e).__name__}")
            self.link.send("search.results", search_id=search_id, responses=0, files=0, folders=[])
        finally:
            self.searching -= 1
            self.touch()

    # ------------------------------------------------------------ downloads

    async def start_job(self, job: Job) -> None:
        batch_id, status = await self.slskd.enqueue(job.id, job.peer, job.path, job.size)
        if not batch_id:
            self.jobs.pop(job.id, None)
            self.report(job, "failed", error="rejected" if status in (403, 409, 429) else "unknown")
            log(f"enqueue failed: http {status}")
            return
        job.batch_id = batch_id
        self.report(job, "queued")

    async def poll_jobs(self) -> None:
        for job in list(self.jobs.values()):
            if job.state in ("uploading", "awaiting") or not job.batch_id:
                continue
            t = await self.slskd.transfer(job.batch_id)
            if not t:
                continue
            job.transfer_id = t.get("id")
            st = t.get("state") or ""
            now = time.monotonic()
            if "Completed" in st:
                if "Succeeded" in st:
                    job.task = asyncio.create_task(self.deliver(job, round((t.get("averageSpeed") or 0) / 1024)))
                    job.state = "uploading"
                else:
                    self.jobs.pop(job.id, None)
                    self.report(job, "failed", error=failure_category(t.get("exception"), st))
            elif "InProgress" in st:
                pct = float(t.get("percentComplete") or 0)
                if job.state != "downloading" or (now - job.last_sent >= PROGRESS_EVERY_S and pct != job.pct):
                    job.pct = pct
                    self.report(job, "downloading", pct=round(pct, 1), kbps=round((t.get("averageSpeed") or 0) / 1024))
            elif "Queued" in st:
                if "Remotely" in st and job.transfer_id and now - job.last_position >= POSITION_EVERY_S:
                    job.last_position = now
                    try:
                        await self.slskd.refresh_position(job.peer, job.transfer_id)
                    except Exception:  # noqa: BLE001
                        pass
                place = t.get("placeInQueue")
                if job.state != "queued" or now - job.last_sent >= POSITION_EVERY_S:
                    self.report(job, "queued", **({"place": place} if place else {}))

    def find_file(self, job: Job) -> Path | None:
        name = job.path.replace("\\", "/").rsplit("/", 1)[-1]
        stem = name.rsplit(".", 1)[0]
        candidates = [p for p in self.dl_dir.rglob("*") if p.is_file() and p.stat().st_size == job.size]
        exact = [p for p in candidates if p.name == name] or [p for p in candidates if p.name.startswith(stem)]
        return max(exact or candidates, key=lambda p: p.stat().st_mtime, default=None)

    def remove(self, path: Path) -> None:
        try:
            path.unlink()
        except PermissionError:
            if self.delete_cmd:
                subprocess.run([*self.delete_cmd, str(path)], check=False)
        except FileNotFoundError:
            pass

    async def deliver(self, job: Job, kbps: int) -> None:
        if job.mode == "direct":
            await self.offer(job)
            return
        self.report(job, "uploading")
        path = None
        try:
            path = self.find_file(job)
            if not path:
                raise CourierError("not_found")
            tags = read_tags(path)
            fmt = (tags.get("format") or "").upper()
            caption = " · ".join(x for x in [job.caption, fmt, f"{path.stat().st_size / 1048576:.0f} MB"] if x)
            message_id = await self.courier.send(job.chat_id, path, caption, tags)
            self.report(job, "delivered", kbps=kbps, track={**tags, "message_id": message_id})
            log(f"delivered: {fmt or '?'} {path.stat().st_size // 1048576} MB")
        except CourierError as e:
            self.report(job, "failed", error=e.category)
            log(f"delivery failed: {e.category}")
        finally:
            if path:
                self.remove(path)
            self.jobs.pop(job.id, None)

    # ------------------------------------------------------------ direct crossing (D8)

    async def offer(self, job: Job) -> None:
        """Keep the finished file untouched behind the door until the member takes it."""
        path = self.find_file(job)
        if not path or not self.door:
            self.jobs.pop(job.id, None)
            self.report(job, "failed", error="not_found")
            return
        job.local, job.tags = path, read_tags(path)
        job.token = secrets.token_urlsafe(24)
        job.offered_at = time.monotonic()
        self.door.offer(job.token, path, path.name)
        self.report(job, "awaiting", token=job.token)
        log(f"awaiting direct crossing: {path.stat().st_size // 1048576} MB")

    def settle_direct(self) -> None:
        if not self.door:
            return
        now = time.monotonic()
        for job in [j for j in self.jobs.values() if j.state == "awaiting" and j.token]:
            if self.door.busy(job.token):
                continue
            if job.released_at and now - job.released_at >= RELEASE_GRACE_S:
                self.close_direct(job, "delivered")
            elif now - job.offered_at >= AWAIT_S:
                self.close_direct(job, "failed", "unclaimed")

    def close_direct(self, job: Job, state: str, error: str | None = None) -> None:
        if self.door and job.token:
            self.door.withdraw(job.token)
        if job.local:
            self.remove(job.local)
        self.jobs.pop(job.id, None)
        if state == "delivered":
            self.report(job, "delivered", track={**(job.tags or {}), "message_id": None})
            log("direct crossing done")
        else:
            self.report(job, "failed", error=error)
            log(f"direct crossing closed: {error}")

    # ------------------------------------------------------------ lifecycle

    async def heartbeat(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(HEARTBEAT_S)
            self.link.send("runner.heartbeat", active_jobs=len(self.jobs), idle_s=int(time.monotonic() - self.last_activity))

    async def watch(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(POLL_S)
            if self.draining:
                continue
            try:
                await self.poll_jobs()
                self.settle_direct()
            except Exception as e:  # noqa: BLE001
                log(f"poll error: {type(e).__name__}")
            idle = not self.jobs and not self.searching and time.monotonic() - self.last_activity > self.idle_s
            if idle:
                asyncio.create_task(self.drain("idle"))
            elif time.monotonic() - self.started > self.max_s:
                asyncio.create_task(self.drain("max_time"))

    async def drain(self, reason: str) -> None:
        if self.draining:
            return
        self.draining = True
        log(f"draining ({reason}), {len(self.jobs)} active jobs")
        self.link.send("session.state", state="draining")
        uploads = [j.task for j in self.jobs.values() if j.task]
        if uploads:
            await asyncio.wait(uploads, timeout=120)
        for job in list(self.jobs.values()):
            if job.state == "awaiting":
                self.close_direct(job, "delivered" if job.released_at else "failed", None if job.released_at else "unclaimed")
                continue
            if job.state == "uploading":
                continue
            if job.transfer_id:
                try:
                    await self.slskd.cancel(job.peer, job.transfer_id)
                except Exception:  # noqa: BLE001
                    pass
            self.jobs.pop(job.id, None)
            self.report(job, "pending")
        status = await self.slskd.logout()
        log(f"soulseek logout: http {status}")
        self.link.send("runner.bye", reason=reason)
        await self.link.flushed()
        self.stop.set()

    async def run(self) -> None:
        if not await self.slskd.wait_logged_in():
            log("soulseek login failed")
            return
        log("soulseek logged in")
        if self.door:
            await self.door.start()
            log("door open behind the tunnel")
        await asyncio.gather(self.link.run(self.stop), self.heartbeat(), self.watch())


if __name__ == "__main__":
    asyncio.run(Agent().run())
