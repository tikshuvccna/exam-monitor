"""Tests for scanner_watch (no OpenCV/EasyOCR needed: OCR is stubbed).

Standalone:   python test/test_watch.py
End-to-end:   python test/test_watch.py <server-url> <scanner-key> <screenshots-dir> <student-name>
              (used by test/smoke.js: posts real alerts to a running test server)
"""
import os
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scanner_watch import split_path, watch, post_alert  # noqa: E402

passed = failed = 0
try:                                  # Windows consoles (cp1255/cp1252) cannot print the check marks
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def ok(cond, name, extra=''):
    global passed, failed
    if cond:
        passed += 1
        print('  ✓', name)
    else:
        failed += 1
        print('  ✗', name, extra)


def make(root: Path, student: str, name: str, content: bytes):
    d = root / date.today().isoformat() / student
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_bytes(b'\xff\xd8\xff\xe0' + content)
    return f


def scan_stub(p: Path):
    data = p.read_bytes()
    if b'BADFILE' in data:
        return None                      # unreadable image
    if b'CHATGPT' in data:
        return ['chatgpt'], []
    if b'OFFLIST' in data:
        return [], ['example-cheat.com']
    return [], []


def sig_stub(p: Path):
    return p.read_bytes()


def unit():
    print('scanner_watch logic')
    root = Path(tempfile.mkdtemp(prefix='watchtest-'))
    ok(split_path(root, root / '2026-01-01' / 'Dana Levi' / 'a.jpg') == ('Dana Levi', '2026-01-01/Dana Levi/a.jpg'), 'split_path')
    ok(split_path(root, root / 'a.jpg') is None, 'split_path ignores files outside date/student/')
    ok(split_path(root, Path('/elsewhere/a.jpg')) is None, 'split_path ignores foreign paths')

    old = make(root, 'Old One', 'old_auto.jpg', b'CHATGPT')
    posted = []
    quiet = lambda *a, **k: None
    st = watch(root, scan_stub, sig_stub, 'http://x', 'k', once=True, post=lambda s, k, p: posted.append(p), log=quiet)
    ok(st['scanned'] == 0 and not posted, 'existing images are ignored by default')

    make(root, 'Dana Levi', 'a_auto.jpg', b'CHATGPT')
    make(root, 'Dana Levi', 'b_auto.jpg', b'CHATGPT')          # identical to a -> skipped
    make(root, 'Dana Levi', 'c_auto.jpg', b'CLEAN')
    make(root, 'Dana Levi', 'd_flag-ai-ai-window.jpg', b'CHATGPT')   # evidence: never skipped
    make(root, 'Dan Cohen', 'x_auto.jpg', b'OFFLIST')
    make(root, 'Dan Cohen', 'y_auto.jpg', b'BADFILE')
    (root / 'notes.txt').write_text('ignore me')
    posted.clear()
    # run one pass (once=True) with include_existing so everything above is considered
    st = watch(root, scan_stub, sig_stub, 'http://x', 'k', once=True, include_existing=True,
               post=lambda s, k, p: posted.append(p), log=quiet)
    ok(st['skipped_same'] == 1, 'identical consecutive frame skipped', st)
    ok(st['errors'] == 1, 'unreadable image counted as error, loop continues', st)
    ai_alerts = [p for p in posted if p['ai']]
    ok(len(ai_alerts) >= 1 and all(p['student'] in ('Dana Levi', 'Old One') for p in ai_alerts), 'AI hit reported with student name', posted)
    ok(any(p['blocked'] == ['example-cheat.com'] and p['student'] == 'Dan Cohen' for p in posted), 'off-list site reported')
    ok(len([p for p in posted if p['student'] == 'Dana Levi']) == 1, 'repeat of same hit within a minute is not re-reported', posted)
    ok(posted and posted[0]['file'].count('/') == 2, 'alert carries relative file path')


def e2e(server, key, shots_dir, student):
    print('end-to-end against the running server')
    root = Path(shots_dir)
    seen_before = {str(p) for p in root.rglob('*.jpg')}
    f1 = make(root, student, f'{student}_e2e_auto.jpg', b'CHATGPT-LIVE')
    quiet = lambda *a, **k: None
    st = watch(root, scan_stub, sig_stub, server, key, once=True, include_existing=True, log=quiet)
    ok(st['alerts'] >= 1, 'watcher raised an alert', st)
    # wrong key must be refused by the real server
    ok(post_alert(server, 'wrong-key', {'student': student, 'file': 'x', 'ai': ['chatgpt'], 'blocked': []}) is False, 'server refuses a wrong key')
    print(f'   created {f1.name}')


if __name__ == '__main__':
    if len(sys.argv) >= 5:
        e2e(*sys.argv[1:5])
    else:
        unit()
    print(f'\n{passed} passed, {failed} failed')
    sys.exit(1 if failed else 0)
