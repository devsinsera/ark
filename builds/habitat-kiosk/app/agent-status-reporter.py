#!/usr/bin/env python3
"""agent-status-reporter — push the FORM Claude session's live status to Supabase
(public.agent_status) so it shows on the sinsera.co dashboard "Build Agent" feed.

Captures the tmux 'form' pane, derives a coarse state + activity line, and upserts
one row (agent='form-build'). Stdlib only (urllib). Runs as the user that owns the
tmux session (peta). Config from /opt/kiosk-agent/.env: SUPABASE_URL, SUPABASE_ANON_KEY.
"""
from __future__ import annotations
import json, os, subprocess, time, urllib.request

def env(path="/opt/kiosk-agent/.env"):
    d = {}
    try:
        for ln in open(path):
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1); d[k] = v
    except FileNotFoundError:
        pass
    return d

CFG = env()
URL = (CFG.get("SUPABASE_URL") or "").rstrip("/")
ANON = CFG.get("SUPABASE_ANON_KEY", "")
SESSION = os.environ.get("AGENT_TMUX", "form")
AGENT = os.environ.get("AGENT_NAME", "form-build")
HOST = os.uname().nodename
INTERVAL = int(os.environ.get("AGENT_INTERVAL_S", "20"))

def capture():
    try:
        return subprocess.run(["tmux", "capture-pane", "-t", SESSION, "-p"],
                              capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return ""

def derive(pane: str):
    lines = [l for l in pane.splitlines() if l.strip()]
    tail = lines[-8:]
    low = pane.lower()
    if "esc to interrupt" in low or "crystallizing" in low or "thinking" in low:
        state = "working"
    elif "error" in low and "no error" not in low:
        state = "error"
    elif "paste code here" in low or "press enter" in low or "login" in low:
        state = "waiting"
    elif any(l.lstrip().startswith("❯") for l in tail):
        state = "idle"
    else:
        state = "working"
    # activity = last Claude action bullet, else last content line
    act = ""
    for l in reversed(tail):
        s = l.strip()
        if s.startswith("●") or s.startswith("⎿"):
            act = s.lstrip("●⎿ ").strip(); break
    if not act and tail:
        act = tail[-1].strip()[:200]
    return state, act[:300], "\n".join(tail)[-1200:]

def push(state, activity, detail):
    if not (URL and ANON):
        return
    body = json.dumps({"agent": AGENT, "host": HOST, "state": state,
                       "activity": activity, "detail": detail,
                       "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}).encode()
    req = urllib.request.Request(
        f"{URL}/rest/v1/agent_status?on_conflict=agent", data=body, method="POST",
        headers={"apikey": ANON, "Authorization": f"Bearer {ANON}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"[agent-status] push failed: {e}", flush=True)

def main():
    print(f"[agent-status] reporting {AGENT}@{HOST} every {INTERVAL}s", flush=True)
    while True:
        st, act, det = derive(capture())
        push(st, act, det)
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
