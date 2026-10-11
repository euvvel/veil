"""Spike stage B: log in to Soulseek from a GitHub runner, search, download, deliver.

The repo is public, so stdout and the report hold counts and categories only:
no queries, filenames, usernames, chat ids or exception text.
Shapes used here come from runner/reference/slskd-0.26.1-openapi.json and
slskd 0.26.1 src/slskd/Search/Types/{Search,Response,File}.cs.
"""

import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

import httpx

API = "http://127.0.0.1:5030/api/v0"
TG = "https://api.telegram.org/bot{token}/{method}"
CLOUD_UPLOAD_LIMIT = 50 * 1024 * 1024
MAX_PICK_BYTES = 45 * 1024 * 1024
AUDIO = {"mp3", "flac", "m4a", "ogg", "opus"}

report: dict = {"stages": {}}
t_start = time.monotonic()


def mark(stage: str, **data) -> None:
    data["t"] = round(time.monotonic() - t_start, 1)
    report["stages"][stage] = data
    print(f"[spike] {stage}: {json.dumps(data)}", flush=True)


def ext_of(f: dict) -> str:
    ext = (f.get("extension") or "").lower().lstrip(".")
    return ext or f["filename"].rsplit(".", 1)[-1].lower()


def failure_category(exc: str | None, state: str) -> str:
    text = (exc or "").lower()
    for needle, cat in [
        ("connection", "connect"),
        ("timed out", "timeout"),
        ("timeout", "timeout"),
        ("rejected", "rejected"),
        ("banned", "rejected"),
        ("queue", "queue"),
        ("not shared", "not_shared"),
        ("file not", "not_shared"),
    ]:
        if needle in text:
            return cat
    return state.split(",")[0].strip().lower() or "unknown"


def wait_logged_in(api: httpx.Client) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            st = api.get("/server").json()
            if st.get("isLoggedIn"):
                mark("login", ok=True)
                return
        except httpx.HTTPError:
            pass
        time.sleep(1)
    mark("login", ok=False)
    raise SystemExit(1)


def find_chat(token: str, code: str) -> int | None:
    r = httpx.get(TG.format(token=token, method="getUpdates"), timeout=20).json()
    chat = None
    last = None
    for u in r.get("result", []):
        last = u["update_id"]
        msg = u.get("message") or {}
        if code in (msg.get("text") or ""):
            chat = msg["chat"]["id"]
    if last is not None:  # acknowledge, so the code is not reused
        httpx.get(TG.format(token=token, method="getUpdates"), params={"offset": last + 1}, timeout=20)
    return chat


def search(api: httpx.Client, text: str) -> tuple[list[dict], float | None]:
    sid = str(uuid.uuid4())
    t0 = time.monotonic()
    api.post("/searches", json={"id": sid, "searchText": text, "searchTimeout": 20000}).raise_for_status()
    first = None
    while time.monotonic() - t0 < 60:
        s = api.get(f"/searches/{sid}").json()
        if first is None and s.get("responseCount"):
            first = round(time.monotonic() - t0, 1)
        if s.get("endedAt"):
            break
        time.sleep(1)
    responses = api.get(f"/searches/{sid}/responses").json()
    report.setdefault("search_states", []).append(s.get("state"))
    return [{"_sid": sid, **r} for r in responses], first


def pick(responses: list[dict], want: int) -> list[tuple[dict, dict]]:
    ranked = sorted(responses, key=lambda r: (not r.get("hasFreeUploadSlot"), r.get("queueLength", 0), -r.get("uploadSpeed", 0)))
    picks, users, by_ext = [], set(), {"flac": 0, "mp3": 0}
    for r in ranked:
        if r["username"] in users:
            continue
        for f in r.get("files", []):
            e = ext_of(f)
            if e in by_ext and f["size"] <= MAX_PICK_BYTES and by_ext[e] < want // 2:
                picks.append((r, f))
                users.add(r["username"])
                by_ext[e] += 1
                break
        if len(picks) >= want:
            break
    return picks


def main() -> None:
    key = os.environ["SLSKD_API_KEY"]
    dl_root = pathlib.Path(os.environ["DL_DIR"])
    token = os.environ["COURIER_BOT_TOKEN"]
    queries = [q.strip() for q in os.environ["SPIKE_QUERIES"].splitlines() if q.strip()]
    api = httpx.Client(base_url=API, headers={"X-API-Key": key}, timeout=30)

    wait_logged_in(api)

    chat = find_chat(token, os.environ["SPIKE_CODE"])
    mark("chat", found=chat is not None)

    all_responses, per_query = [], []
    for q in queries:
        rs, first = search(api, q)
        files = sum(len(r.get("files", [])) for r in rs)
        per_query.append({"responses": len(rs), "files": files,
                          "free_slot": sum(1 for r in rs if r.get("hasFreeUploadSlot")),
                          "locked_files": sum(r.get("lockedFileCount", 0) for r in rs),
                          "first_result_s": first})
        all_responses += rs
    mark("search", queries=per_query)
    if all_responses:
        report["shape_response_keys"] = sorted(all_responses[0].keys())
        f0 = (all_responses[0].get("files") or [{}])[0]
        report["shape_file_keys"] = sorted(f0.keys())

    picks = pick(all_responses, want=8)
    batches = []
    for r, f in picks:
        body = {"id": str(uuid.uuid4()), "searchId": r["_sid"], "username": r["username"],
                "files": [{"filename": f["filename"], "size": f["size"]}],
                "options": {"externalId": str(uuid.uuid4())}}
        res = api.post("/transfers/downloads/batches", json=body)
        batches.append({"id": body["id"], "status": res.status_code, "ext": ext_of(f), "size": f["size"],
                        "free_slot": r.get("hasFreeUploadSlot"), "basename": f["filename"].replace("\\", "/").rsplit("/", 1)[-1]})
    mark("enqueue", count=len(batches), statuses=sorted({b["status"] for b in batches}))

    deadline = time.monotonic() + 8 * 60
    results = {}
    while time.monotonic() < deadline and len(results) < len(batches):
        for b in batches:
            if b["id"] in results or b["status"] >= 300:
                continue
            res = api.get(f"/transfers/downloads/batches/{b['id']}")
            if res.status_code != 200:
                continue
            t = (res.json().get("transfers") or [{}])[0]
            state = t.get("state") or ""
            if "Completed" in state:
                results[b["id"]] = {"ok": "Succeeded" in state,
                                    "category": "ok" if "Succeeded" in state else failure_category(t.get("exception"), state),
                                    "kbps": round((t.get("averageSpeed") or 0) / 1024),
                                    "queued_place": t.get("placeInQueue")}
        time.sleep(3)
    for b in batches:
        results.setdefault(b["id"], {"ok": False, "category": "unfinished_8min"})
    cats: dict = {}
    for r in results.values():
        cats[r["category"]] = cats.get(r["category"], 0) + 1
    mark("download", attempted=len(batches), succeeded=sum(r["ok"] for r in results.values()),
         categories=cats, kbps=[r.get("kbps") for r in results.values() if r["ok"]],
         by_free_slot={str(fs): [results[b["id"]]["ok"] for b in batches if b["free_slot"] == fs] for fs in (True, False)})

    delivered = []
    if chat is not None:
        files = {p.name: p for p in dl_root.rglob("*") if p.is_file()}
        for want_ext, method, field in (("mp3", "sendAudio", "audio"), ("flac", "sendDocument", "document")):
            b = next((b for b in batches if results[b["id"]]["ok"] and b["ext"] == want_ext and b["basename"] in files), None)
            if not b:
                continue
            path = files[b["basename"]]
            if path.stat().st_size > CLOUD_UPLOAD_LIMIT:
                continue
            t0 = time.monotonic()
            with path.open("rb") as fh:
                r = httpx.post(TG.format(token=token, method=method), data={"chat_id": chat, "caption": "veil · spike crossing"},
                               files={field: (path.name, fh)}, timeout=300).json()
            delivered.append({"ext": want_ext, "method": method, "ok": r.get("ok"), "s": round(time.monotonic() - t0, 1),
                              "mb": round(path.stat().st_size / 1048576, 1),
                              "shown_as": sorted(k for k in ("audio", "document") if k in r.get("result", {}))})
    mark("deliver", items=delivered)

    # slskd runs as root in its container, so its files need sudo to remove.
    subprocess.run(["sudo", "find", str(dl_root), "-mindepth", "1", "-delete"], check=False)
    mark("cleanup", leftover=sum(1 for _ in dl_root.rglob("*")))

    res = api.request("DELETE", "/server", json="veil spike done")
    time.sleep(2)
    mark("logout", status=res.status_code, logged_in_after=api.get("/server").json().get("isLoggedIn"))


if __name__ == "__main__":
    try:
        main()
    finally:
        out = pathlib.Path(os.environ["OUT_DIR"]) / "report.json"
        out.write_text(json.dumps(report, indent=2))
        sys.exit(0)
