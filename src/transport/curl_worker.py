"""Browser-compatible HTTPS client for hosts that refuse Node's TLS handshake (DraftKings' snapshot host).

DraftKings' REST snapshot host (Akamai) answers 403 to Node's fetch from cloud IPs, but accepts a client whose
TLS + HTTP/2 handshake looks like Chrome's. curl_cffi provides that (libcurl-impersonate). This worker is started
once by src/transport/http.js and kept alive, so a snapshot costs one request on a warm connection (~60-100 ms),
not a process start + a fresh TLS handshake.

Protocol: one JSON object per line.
  stdin : {"id": 7, "url": "...", "method": "GET", "headers": {...}, "body": null, "timeout": 15}
  stdout: {"id": 7, "status": 200, "body": "...", "retryAfter": null, "ms": 64}   or   {"id": 7, "error": "..."}
The first line written is {"id": null, "ready": true}. Up to 4 requests run at once (one session per thread).
"""
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from curl_cffi.requests import Session

local = threading.local()
out_lock = threading.Lock()
# Let the impersonated browser supply its own matching User-Agent and client hints: a UA from another Chrome
# version than the TLS fingerprint is exactly the kind of mismatch bot filters look for.
DROP = {"user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "host", "content-length", "connection"}


def session():
    s = getattr(local, "s", None)
    if s is None:
        s = local.s = Session(impersonate="chrome", trust_env=False)
    return s


def send(obj):
    line = json.dumps(obj, separators=(",", ":"))
    with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def handle(req):
    rid = req.get("id")
    t0 = time.monotonic()
    try:
        headers = {k: v for k, v in (req.get("headers") or {}).items() if k.lower() not in DROP}
        r = session().request(req.get("method") or "GET", req["url"], headers=headers, data=req.get("body"),
                              timeout=float(req.get("timeout") or 15))
        send({"id": rid, "status": r.status_code, "body": r.text, "retryAfter": r.headers.get("retry-after"),
              "ms": round((time.monotonic() - t0) * 1000)})
    except Exception as e:  # a failed request must never kill the worker
        local.s = None  # next request on this thread starts a clean session
        send({"id": rid, "error": f"{type(e).__name__}: {e}"[:300], "ms": round((time.monotonic() - t0) * 1000)})


def main():
    pool = ThreadPoolExecutor(max_workers=4)
    send({"id": None, "ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        pool.submit(handle, req)
    pool.shutdown(wait=False)


if __name__ == "__main__":
    main()
