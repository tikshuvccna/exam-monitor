"""Live watch mode for scanner.py.

Kept separate from the OCR code so the logic (which files to scan, de-duplication,
reporting alerts to the exam server) can be tested without OpenCV/EasyOCR installed.

Usage (via scanner.py):
    python scanner.py --watch --server https://localhost:4555 --key <scannerKey>
The scannerKey is printed by the server at start-up and stored in config.json.
"""
import json
import ssl
import time
import urllib.request
from pathlib import Path

VALID_EXT = {'.jpg', '.jpeg', '.png', '.webp'}


def split_path(root: Path, path: Path):
    """screenshots/<date>/<student>/<file> -> (student, 'date/student/file') or None."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        return None
    if len(rel.parts) != 3:
        return None
    return rel.parts[1], '/'.join(rel.parts)


def post_alert(server: str, key: str, payload: dict, timeout: float = 8.0) -> bool:
    body = json.dumps({**payload, 'key': key}).encode('utf-8')
    req = urllib.request.Request(server.rstrip('/') + '/scan-alert', data=body,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    ctx = ssl.create_default_context()
    # The exam server uses a self-signed certificate on the local network.
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status == 200
    except Exception as e:  # network errors must never stop the scan loop
        print(f'   [!] could not report to server: {e}')
        return False


def list_images(root: Path):
    return [p for p in root.rglob('*') if p.suffix.lower() in VALID_EXT]


def watch(root, scan_fn, signature_fn, server, key, interval=3.0,
          include_existing=False, once=False, post=post_alert, sleep=time.sleep, log=print):
    """Poll `root` for new screenshots, scan them and report violations to the server.

    scan_fn(path) -> (ai_hits: list[str], blocked: list[str]) or None on read error.
    signature_fn(path) -> hashable "fingerprint" of the image; identical consecutive
        frames of the same student are skipped (flag evidence is always scanned).
    once: process what is there now and return (used by tests).
    """
    root = Path(root)
    seen = set()
    last_sig = {}
    last_alert = {}   # (student, hits) -> time, so a tab left open does not alert every frame
    stats = {'scanned': 0, 'skipped_same': 0, 'alerts': 0, 'errors': 0}
    if not include_existing:
        seen.update(str(p) for p in list_images(root))
        log(f'Watching {root} (ignoring {len(seen)} existing image(s)). Ctrl+C to stop.')
    else:
        log(f'Watching {root} (scanning existing images too). Ctrl+C to stop.')

    while True:
        fresh = sorted((p for p in list_images(root) if str(p) not in seen), key=lambda p: p.stat().st_mtime)
        # Evidence shots (taken at the moment of a flag) first: they matter most.
        fresh.sort(key=lambda p: 0 if '_flag-' in p.name else 1)
        for p in fresh:
            seen.add(str(p))
            info = split_path(root, p)
            if not info:
                continue
            student, rel = info
            is_evidence = '_flag-' in p.name
            if not is_evidence:
                try:
                    sig = signature_fn(p)
                except Exception:
                    sig = None
                if sig is not None and last_sig.get(student) == sig:
                    stats['skipped_same'] += 1
                    continue
                last_sig[student] = sig
            res = scan_fn(p)
            if res is None:
                stats['errors'] += 1
                continue
            stats['scanned'] += 1
            ai_hits, blocked = res
            if ai_hits or blocked:
                akey = (student, tuple(ai_hits), tuple(blocked))
                if time.time() - last_alert.get(akey, 0) < 60:
                    continue
                last_alert[akey] = time.time()
                stats['alerts'] += 1
                log(f'VIOLATION  {student}: AI={ai_hits} not-allowed={blocked}  ({p.name})')
                post(server, key, {'student': student, 'file': rel, 'ai': ai_hits, 'blocked': blocked})
        if once:
            return stats
        sleep(interval)
