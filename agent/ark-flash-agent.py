#!/usr/bin/env python3
"""Ark Flash Agent — turns a Raspberry Pi (or any Linux box) into a
network imaging appliance for the Ark Hub.

Responsibilities:
    - Register with the Hub on startup, heartbeat every 30s
    - List attached storage (lsblk-based, with safety annotations)
    - Accept image jobs from the Hub (POST /jobs)
    - Verify image sha256 before any write
    - Write via bmaptool when available, fall back to dd
    - Stream progress over WebSocket
    - Post-write: sync + readable mount test + safe unmount
    - Hard refuse to write to mounted / system / non-removable disks

Stack: FastAPI + uvicorn. Install via agent/install-flash-agent.sh
which pip-installs the deps and sets up the systemd unit.

NEVER reads or transmits credentials. The image bytes themselves
might contain operator-supplied creds (e.g. embedded WiFi keys);
those flow through the Flash Agent unmodified — sanitising that is
the Installer Engine's job, upstream.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

try:
    from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
except ImportError:
    print("[flash-agent] FATAL: fastapi not installed. Run: pip install fastapi uvicorn[standard] python-multipart", file=sys.stderr)
    sys.exit(2)


AGENT_VERSION = "0.1.0"

# Configuration (env)
HUB_URL          = os.environ.get("ARK_HUB_URL", "").rstrip("/")
NODE_NAME        = os.environ.get("ARK_FLASH_NODE_NAME") or socket.gethostname()
NODE_ID          = os.environ.get("ARK_FLASH_NODE_ID")   or _persistent_node_id()
LISTEN_HOST      = os.environ.get("ARK_FLASH_LISTEN_HOST", "0.0.0.0")
LISTEN_PORT      = int(os.environ.get("ARK_FLASH_LISTEN_PORT", "7410"))
IMAGE_STAGING    = Path(os.environ.get("ARK_FLASH_STAGING", "/var/lib/ark-flash/images"))
HEARTBEAT_S      = int(os.environ.get("ARK_FLASH_HEARTBEAT_S", "30"))
WRITE_CHUNK      = 4 * 1024 * 1024  # 4 MB chunks for dd-style streaming progress

IMAGE_STAGING.mkdir(parents=True, exist_ok=True)


def _persistent_node_id() -> str:
    # Stable node_id per host so re-registrations don't churn DB rows.
    p = Path("/var/lib/ark-flash/node-id")
    if p.exists():
        return p.read_text().strip()
    p.parent.mkdir(parents=True, exist_ok=True)
    nid = "flash_" + uuid.uuid4().hex[:12]
    p.write_text(nid)
    return nid


# ── Disk detection ─────────────────────────────────────────────────
def _lsblk_json() -> dict:
    out = subprocess.run(
        ["lsblk", "-bJ", "-o", "NAME,PATH,TYPE,RM,SIZE,FSTYPE,MOUNTPOINTS,RO,MODEL,VENDOR,TRAN"],
        check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout)


def _root_disk() -> Optional[str]:
    """Disk that the running OS booted from. Never write to this."""
    try:
        out = subprocess.run(["findmnt", "-n", "-o", "SOURCE", "/"], check=True, capture_output=True, text=True).stdout.strip()
        # /dev/mmcblk0p2 → /dev/mmcblk0; /dev/sda3 → /dev/sda
        m = re.match(r"^(/dev/[a-z]+)(p?)(\d+)?$", out)
        if m: return m.group(1)
        m = re.match(r"^(/dev/mmcblk\d)p?\d*$", out)
        if m: return m.group(1)
    except Exception:
        pass
    return None


def list_disks() -> list[dict]:
    """Return one record per top-level block device with safety flags."""
    data = _lsblk_json()
    root = _root_disk()
    result = []
    for d in data.get("blockdevices", []):
        if d.get("type") != "disk":
            continue
        path = d.get("path") or f"/dev/{d.get('name')}"
        removable = bool(d.get("rm"))
        readonly  = bool(d.get("ro"))
        mounted   = _any_mounted(d)
        is_root   = (path == root)
        # Classify type
        tran = (d.get("tran") or "").lower()
        if   "nvme" in (d.get("name") or ""): kind = "nvme"
        elif tran == "usb":                   kind = "usb"
        elif "mmc" in (d.get("name") or ""):  kind = "sd"
        elif tran in ("sata", "ata"):         kind = "ssd"
        else: kind = "other"
        safe = removable and not readonly and not mounted and not is_root
        result.append({
            "path":      path,
            "name":      d.get("name"),
            "type":      kind,
            "size":      d.get("size"),
            "removable": removable,
            "readonly":  readonly,
            "mounted":   mounted,
            "is_root_disk": is_root,
            "safe_to_write": safe,
            "model":     d.get("model"),
            "vendor":    d.get("vendor"),
            "transport": tran or None,
        })
    return result


def _any_mounted(node) -> bool:
    if node.get("mountpoints"):
        if any(mp for mp in node.get("mountpoints") if mp):
            return True
    for child in node.get("children", []) or []:
        if _any_mounted(child):
            return True
    return False


# ── Safety layer (echoed from Hub-side validation; defense in depth) ─
def assert_safe_target(path: str, allow_root_override: bool = False) -> None:
    """Raise HTTPException if the target is unsafe to write."""
    disks = list_disks()
    d = next((x for x in disks if x["path"] == path), None)
    if not d:
        raise HTTPException(400, f"unknown disk: {path}")
    if d["is_root_disk"] and not allow_root_override:
        raise HTTPException(403, f"refusing to write to root disk {path}")
    if d["mounted"]:
        raise HTTPException(409, f"target {path} has a mounted partition — unmount first")
    if d["readonly"]:
        raise HTTPException(403, f"target {path} is read-only")
    if not d["removable"] and not allow_root_override:
        raise HTTPException(403, f"target {path} is not removable; pass allow_root_override=true to force")


# ── Hub registration + heartbeat ───────────────────────────────────
def register_with_hub() -> None:
    if not HUB_URL:
        print("[flash-agent] ARK_HUB_URL not set; running standalone (no Hub registration)", flush=True)
        return
    import urllib.request
    payload = {
        "node_id":       NODE_ID,
        "node_name":     NODE_NAME,
        "hardware_model": _hardware_model(),
        "capabilities": _capabilities(),
        "status":        "idle",
        "agent_url":     f"http://{_primary_ip() or NODE_NAME}.local:{LISTEN_PORT}",
    }
    try:
        req = urllib.request.Request(
            HUB_URL + "/api/flash/nodes/register",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).read()
        print(f"[flash-agent] registered with Hub as {NODE_ID}", flush=True)
    except Exception as e:
        print(f"[flash-agent] registration failed (non-fatal): {e}", flush=True)


def _capabilities() -> list[str]:
    caps = ["sd_write", "verify"]
    if shutil.which("bmaptool"): caps.append("ssd_write")
    return caps


def _hardware_model() -> Optional[str]:
    try:
        return Path("/proc/device-tree/model").read_text().strip("\x00").strip()
    except Exception:
        return None


def _primary_ip() -> Optional[str]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 53))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return None


async def heartbeat_loop() -> None:
    import urllib.request
    while True:
        await asyncio.sleep(HEARTBEAT_S)
        if not HUB_URL: continue
        try:
            req = urllib.request.Request(
                HUB_URL + f"/api/flash/nodes/{NODE_ID}/heartbeat",
                data=json.dumps({"status": _current_status()}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:
            pass


def _current_status() -> str:
    # If any job is in a non-terminal state, we're busy.
    for j in JOBS.values():
        if j["state"] in ("preparing", "writing", "syncing", "verifying", "mount_test"):
            return "busy"
    return "idle"


# ── Job store + lifecycle ───────────────────────────────────────────
JOBS: dict[str, dict] = {}
JOB_SUBSCRIBERS: dict[str, set[WebSocket]] = {}


def _push_progress(job_id: str, fields: dict) -> None:
    j = JOBS.get(job_id)
    if not j: return
    j.update(fields)
    j["updated_at"] = time.time()
    # Notify any WS subscribers (fire-and-forget)
    subs = list(JOB_SUBSCRIBERS.get(job_id, []))
    if subs:
        msg = json.dumps({"job_id": job_id, **fields, "ts": j["updated_at"]})
        for ws in subs:
            asyncio.create_task(_safe_ws_send(ws, msg))
    # Tell the Hub too (best-effort)
    if HUB_URL and j.get("hub_job_id"):
        import urllib.request
        try:
            req = urllib.request.Request(
                HUB_URL + f"/api/flash/jobs/{j['hub_job_id']}/update",
                data=json.dumps(fields).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2).read()
        except Exception:
            pass


async def _safe_ws_send(ws: WebSocket, msg: str) -> None:
    try: await ws.send_text(msg)
    except Exception: pass


async def run_job(job_id: str) -> None:
    j = JOBS[job_id]
    image_path = j["image_path"]
    target     = j["target_disk_path"]
    expected_sha = j["sha256"]
    j["started_at"] = time.time()
    try:
        # ── Prepare: verify image checksum ──
        _push_progress(job_id, {"state": "preparing"})
        actual = await _sha256_file_async(image_path, lambda pct: _push_progress(job_id, {"verify_pct": pct}))
        if actual != expected_sha:
            raise RuntimeError(f"image sha mismatch: expected {expected_sha}, got {actual}")
        # ── Safety check (final) ──
        assert_safe_target(target, allow_root_override=j.get("allow_root_override", False))
        # ── Write ──
        _push_progress(job_id, {"state": "writing", "progress_pct": 0})
        await _write_image_async(image_path, target, job_id)
        # ── Sync ──
        _push_progress(job_id, {"state": "syncing"})
        await asyncio.get_running_loop().run_in_executor(None, lambda: subprocess.run(["sync"], check=True))
        # ── Verify (sample-based) ──
        _push_progress(job_id, {"state": "verifying"})
        await _verify_written_image_async(image_path, target, job_id)
        # ── Mount test ──
        _push_progress(job_id, {"state": "mount_test"})
        ok, msg = _try_readable_mount(target)
        if not ok:
            raise RuntimeError(f"mount test failed: {msg}")
        # ── Done ──
        _push_progress(job_id, {"state": "completed", "completed_at": time.time(), "progress_pct": 100})
    except Exception as e:
        _push_progress(job_id, {"state": "failed", "error": str(e), "completed_at": time.time()})


async def _sha256_file_async(path: str, on_progress=None) -> str:
    loop = asyncio.get_running_loop()
    def _hash():
        h = hashlib.sha256()
        size = os.path.getsize(path)
        done = 0
        with open(path, "rb") as f:
            while True:
                chunk = f.read(WRITE_CHUNK)
                if not chunk: break
                h.update(chunk)
                done += len(chunk)
                if on_progress and size:
                    on_progress(int(done / size * 100))
        return h.hexdigest()
    return await loop.run_in_executor(None, _hash)


async def _write_image_async(src: str, dst: str, job_id: str) -> None:
    """Prefer bmaptool when present; fall back to chunked dd-style copy."""
    loop = asyncio.get_running_loop()
    if shutil.which("bmaptool"):
        # bmaptool emits progress on stderr; capture it.
        proc = await asyncio.create_subprocess_exec(
            "bmaptool", "copy", "--nobmap", src, dst,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await _stream_proc_progress(proc, job_id)
    else:
        # Chunked Python copy with sync at the end.
        size = os.path.getsize(src)
        start = time.time()
        def _copy():
            with open(src, "rb") as fi, open(dst, "wb") as fo:
                done = 0
                last_push = 0
                while True:
                    chunk = fi.read(WRITE_CHUNK)
                    if not chunk: break
                    fo.write(chunk)
                    done += len(chunk)
                    now = time.time()
                    if now - last_push > 1.0 and size > 0:
                        pct = int(done / size * 100)
                        speed_mbps = (done / (now - start)) / (1024 * 1024)
                        eta = int((size - done) / max(1, (done / (now - start))))
                        # Schedule progress push on the event loop.
                        asyncio.run_coroutine_threadsafe(
                            _push_progress_async(job_id, {"progress_pct": pct, "bytes_written": done,
                                                          "write_speed_mbps": round(speed_mbps, 1), "eta_s": eta}),
                            loop,
                        )
                        last_push = now
                fo.flush()
                os.fsync(fo.fileno())
        await loop.run_in_executor(None, _copy)


async def _push_progress_async(job_id: str, fields: dict) -> None:
    _push_progress(job_id, fields)


async def _stream_proc_progress(proc, job_id: str) -> None:
    """Read bmaptool stderr lines and parse progress."""
    assert proc.stderr
    while True:
        line = await proc.stderr.readline()
        if not line: break
        text = line.decode(errors="ignore").strip()
        m = re.search(r"(\d+)%", text)
        if m:
            _push_progress(job_id, {"progress_pct": int(m.group(1)), "log_tail": text})
    rc = await proc.wait()
    if rc != 0:
        raise RuntimeError(f"bmaptool exited {rc}")


async def _verify_written_image_async(src: str, dst: str, job_id: str) -> None:
    """Sample-based verify: read N random 1 MB segments from both src
    and dst and compare. Faster than full re-hash; catches most write
    corruption without ballooning verify time on large images."""
    loop = asyncio.get_running_loop()
    def _check():
        SAMPLE_BYTES = 1024 * 1024
        SAMPLES = 8
        size = os.path.getsize(src)
        import random
        random.seed(42)
        with open(src, "rb") as fs, open(dst, "rb") as fd:
            for i in range(SAMPLES):
                off = random.randint(0, max(0, size - SAMPLE_BYTES))
                off = (off // 4096) * 4096   # align
                fs.seek(off); fd.seek(off)
                a = fs.read(SAMPLE_BYTES)
                b = fd.read(SAMPLE_BYTES)
                if a != b:
                    raise RuntimeError(f"verify sample {i+1}/{SAMPLES} at offset {off} differs")
                _push_progress(job_id, {"verify_pct": int((i + 1) / SAMPLES * 100)})
    await loop.run_in_executor(None, _check)


def _try_readable_mount(disk: str) -> tuple[bool, str]:
    """Mount the first partition read-only and check we can list its
    contents. Returns (ok, message)."""
    import tempfile
    # Pi-style partition names: /dev/sda1, /dev/mmcblk0p1, /dev/nvme0n1p1
    p1 = disk + ("p1" if (disk.endswith(("mmcblk0", "nvme0n1")) or "mmcblk" in disk or "nvme" in disk) else "1")
    if not Path(p1).exists():
        return True, f"no partition table — write succeeded but no {p1} to mount-test"
    mnt = Path(tempfile.mkdtemp(prefix="ark-flash-mt-"))
    try:
        subprocess.run(["mount", "-o", "ro", p1, str(mnt)], check=True, timeout=10, capture_output=True)
        entries = list(mnt.iterdir())
        subprocess.run(["umount", str(mnt)], check=True, timeout=10, capture_output=True)
        return True, f"mounted {p1} ro, saw {len(entries)} top-level entries"
    except subprocess.CalledProcessError as e:
        try: subprocess.run(["umount", str(mnt)], capture_output=True)
        except Exception: pass
        return False, f"mount failed: {e.stderr.decode(errors='ignore').strip() if e.stderr else str(e)}"
    finally:
        try: mnt.rmdir()
        except Exception: pass


# ── HTTP server ────────────────────────────────────────────────────
app = FastAPI(title="Ark Flash Agent", version=AGENT_VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class JobRequest(BaseModel):
    hub_job_id:       Optional[str] = None
    image_path:       Optional[str] = None      # absolute path if image already on the Pi
    image_url:        Optional[str] = None      # else Hub URL to fetch from
    sha256:           str
    target_disk_path: str
    allow_root_override: bool = False


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "agent_version": AGENT_VERSION,
        "node_id": NODE_ID,
        "node_name": NODE_NAME,
        "hardware_model": _hardware_model(),
        "active_jobs": sum(1 for j in JOBS.values() if j["state"] not in ("completed", "failed", "cancelled")),
        "status": _current_status(),
    }


@app.get("/disks")
def disks():
    return {"disks": list_disks(), "root_disk": _root_disk()}


@app.post("/upload")
async def upload(image: UploadFile = File(...)):
    """Stage an image into IMAGE_STAGING. Returns the staged path."""
    name = re.sub(r"[^a-zA-Z0-9._-]", "_", image.filename or "upload.img")
    dest = IMAGE_STAGING / name
    with dest.open("wb") as f:
        while chunk := await image.read(WRITE_CHUNK):
            f.write(chunk)
    return {"path": str(dest), "size_bytes": dest.stat().st_size}


@app.post("/jobs")
async def create_job(req: JobRequest, bg: BackgroundTasks):
    assert_safe_target(req.target_disk_path, allow_root_override=req.allow_root_override)
    # Resolve image source
    if req.image_path:
        if not Path(req.image_path).exists():
            raise HTTPException(404, f"image_path not found: {req.image_path}")
        image_path = req.image_path
    elif req.image_url:
        image_path = await _fetch_image(req.image_url, req.sha256)
    else:
        raise HTTPException(400, "image_path or image_url required")

    job_id = "flash_" + uuid.uuid4().hex[:12]
    JOBS[job_id] = {
        "job_id": job_id, "hub_job_id": req.hub_job_id,
        "image_path": image_path, "sha256": req.sha256,
        "target_disk_path": req.target_disk_path,
        "allow_root_override": req.allow_root_override,
        "state": "queued", "progress_pct": 0, "bytes_written": 0,
        "created_at": time.time(),
    }
    bg.add_task(run_job, job_id)
    return JOBS[job_id]


@app.get("/jobs")
def list_jobs():
    return {"jobs": list(JOBS.values())}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    j = JOBS.get(job_id)
    if not j: raise HTTPException(404, "job not found")
    return j


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    j = JOBS.get(job_id)
    if not j: raise HTTPException(404, "job not found")
    if j["state"] in ("completed", "failed", "cancelled"):
        return j
    j["state"] = "cancelled"; j["completed_at"] = time.time()
    return j


@app.websocket("/jobs/{job_id}/stream")
async def job_stream(ws: WebSocket, job_id: str):
    await ws.accept()
    JOB_SUBSCRIBERS.setdefault(job_id, set()).add(ws)
    try:
        # Send current state immediately
        if job_id in JOBS:
            await ws.send_text(json.dumps({"job_id": job_id, **JOBS[job_id]}))
        while True:
            await asyncio.sleep(30)
            await ws.send_text(json.dumps({"heartbeat": True}))
    except WebSocketDisconnect:
        pass
    finally:
        JOB_SUBSCRIBERS.get(job_id, set()).discard(ws)


async def _fetch_image(url: str, expected_sha: str) -> str:
    import urllib.request
    name = re.sub(r"[^a-zA-Z0-9._-]", "_", url.split("/")[-1]) or "fetched.img"
    dest = IMAGE_STAGING / name
    def _dl():
        with urllib.request.urlopen(url, timeout=30) as resp, dest.open("wb") as f:
            while chunk := resp.read(WRITE_CHUNK):
                f.write(chunk)
    await asyncio.get_running_loop().run_in_executor(None, _dl)
    actual = await _sha256_file_async(str(dest))
    if actual != expected_sha:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"fetched image sha mismatch ({actual} vs {expected_sha})")
    return str(dest)


@app.on_event("startup")
async def _startup():
    register_with_hub()
    asyncio.create_task(heartbeat_loop())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT)
