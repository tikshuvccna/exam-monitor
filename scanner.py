import cv2
import easyocr
import re
import csv
import numpy as np
from pathlib import Path
from datetime import datetime

# ============================================================
#  CONFIGURATION
# ============================================================

ADDRESS_BAR_RATIOS = [0.04, 0.07, 0.10, 0.14]
TAB_BAR_RATIO      = 0.05
UPSCALE_FACTOR     = 3.0
CLAHE_CLIP         = 3.0

# TLDs ordered longest-first to avoid .il matching before .co.il
TLDS = [
    # Double TLDs (must come first)
    ".co.il", ".org.il", ".net.il", ".ac.il", ".gov.il", ".muni.il",
    ".co.uk", ".org.uk", ".me.uk", ".ac.uk",
    ".com.au", ".net.au", ".org.au",
    # AI / tech
    ".ai", ".io", ".dev", ".app", ".cloud", ".tech",
    ".online", ".site", ".web",
    # Generic
    ".com", ".org", ".net", ".edu", ".gov", ".int", ".mil",
    # Commerce
    ".store", ".shop", ".co", ".biz",
    # Media
    ".tv", ".media", ".news",
    # Country
    ".il", ".us", ".eu", ".de", ".fr", ".nl", ".ru", ".cn",
    ".br", ".ca", ".au", ".jp", ".kr", ".in",
    # Other
    ".info", ".me", ".xyz", ".space", ".live", ".pro",
]

# ── AI detection ─────────────────────────────────────────────

AI_DOMAINS = [
    "chatgpt.com", "chat.openai.com", "openai.com",
    "gemini.google.com", "bard.google.com",
    "claude.ai", "anthropic.com",
    "copilot.microsoft.com", "bing.com/chat",
    "perplexity.ai", "you.com", "poe.com",
    "huggingface.co", "mistral.ai", "cohere.com",
    "groq.com", "grok.x.ai", "character.ai",
    "replika.com", "jasper.ai", "writesonic.com", "copy.ai",
    "phind.com", "blackboxai.com", "kagi.com",
    "aistudio.google.com", "labs.google",
]

AI_TAB_KEYWORDS = [
    "chatgpt", "claude", "gemini", "copilot", "perplexity",
    "bard", "mistral", "huggingface", "grok", "chatbot",
    "openai", "anthropic",
]

AI_URL_KEYWORDS = [
    "openai", "chatgpt", "claude", "gemini", "copilot",
    "gpt-", "/gpt", "llm", "bard", "perplexity",
    "mistral", "huggingface", "groq", "grok", "aistudio",
]

# ============================================================
#  SETUP
# ============================================================
print("Loading OCR model... please wait.")
reader = easyocr.Reader(['en'], gpu=False)


# ============================================================
#  ADAPTIVE CONTRAST
# ============================================================

def is_dark_background(strip: np.ndarray) -> bool:
    """
    Detect whether the strip has a dark or light background
    by looking at the median brightness of the image.
    """
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    median = np.median(gray)
    return median < 128


def normalize_to_light_bg(gray: np.ndarray) -> np.ndarray:
    """
    Ensure text is dark on light background (best for OCR).
    If background is dark, invert the image.
    """
    median = np.median(gray)
    if median < 128:
        return cv2.bitwise_not(gray)
    return gray


def sharpen(img: np.ndarray) -> np.ndarray:
    """Apply an unsharp mask to make text edges crisper."""
    blurred = cv2.GaussianBlur(img, (0, 0), 3)
    return cv2.addWeighted(img, 1.5, blurred, -0.5, 0)


def preprocess_strip(strip: np.ndarray, upscale: float = None) -> tuple:
    """
    Full preprocessing pipeline:
      1. Upscale
      2. Grayscale
      3. Adaptive invert (dark bg → invert so text is always dark-on-light)
      4. Sharpen
      5. CLAHE contrast enhancement
      6. Two binarization methods (Otsu + Adaptive)
    Returns (otsu, adaptive) — both guaranteed dark-text-on-white.
    """
    if upscale is None:
        upscale = UPSCALE_FACTOR

    h, w = strip.shape[:2]
    strip = cv2.resize(strip, (int(w * upscale), int(h * upscale)),
                       interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    gray = normalize_to_light_bg(gray)
    gray = sharpen(gray)

    clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    adaptive = cv2.adaptiveThreshold(gray, 255,
                                     cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                     cv2.THRESH_BINARY, 31, 10)
    return otsu, adaptive


def ocr_region(strip: np.ndarray, upscale: float = None) -> str:
    """Run OCR with both binarization methods; return the longer (richer) result."""
    otsu, adaptive = preprocess_strip(strip, upscale)
    best = ""
    for img in [otsu, adaptive]:
        results = reader.readtext(img, detail=0, paragraph=False)
        text = " ".join(results).lower()
        if len(text) > len(best):
            best = text
    return best


# ============================================================
#  ANCHOR-BASED URL EXTRACTION
# ============================================================

def normalise_ocr(text: str) -> str:
    """
    Produce two normalised variants and return all three joined,
    so downstream search can find a match in any form.
      - original
      - letter→digit  (fixes 'o' read as '0' in IPs)
      - digit→letter  (fixes '0' read as 'o' in domains)
    """
    l2d = str.maketrans("oOiIlL|!", "00111111")
    d2l = str.maketrans("01", "oi")
    return text + " " + text.translate(l2d) + " " + text.translate(d2l)


def extract_urls_anchor(raw_text: str) -> set:
    """
    Anchor-based extraction:
      1. Find every TLD occurrence in the normalised text
      2. Grab up to 40 chars before it as the domain part
      3. Extract the last valid label sequence before the TLD
      4. Optionally grab a path after the TLD

    This avoids trying to parse a full URL from noisy OCR output.
    """
    text = normalise_ocr(raw_text)
    found = set()

    for tld in TLDS:
        start = 0
        while True:
            pos = text.find(tld, start)
            if pos == -1:
                break
            start = pos + 1

            # Make sure this TLD is not part of a longer TLD already captured
            after = text[pos + len(tld):]
            # Skip if immediately followed by a letter (e.g. ".com" inside ".commerce")
            if after and after[0].isalpha():
                continue

            # Grab up to 60 chars before the TLD
            before = text[max(0, pos - 60): pos]

            # Extract the domain label(s) immediately before the TLD
            # A label is [a-z0-9] with optional hyphens inside
            label_pattern = re.compile(r'[a-z0-9][a-z0-9\-]*(?:\.[a-z0-9][a-z0-9\-]*)*$')
            match = label_pattern.search(before.replace(" ", ""))
            if not match:
                continue

            domain_part = match.group()

            # Minimum: at least 2 chars before TLD (avoids "a.com")
            if len(domain_part) < 2:
                continue

            # Grab optional path after TLD (up to next space or end)
            path_match = re.match(r'(/[^\s]*)?', after)
            path = path_match.group(0) if path_match else ""

            url = domain_part + tld + path
            found.add(url)

    return found


# ============================================================
#  RULE PARSING & MATCHING
# ============================================================

def parse_rule(raw_rule: str) -> dict:
    raw = raw_rule.strip().lower()
    raw = raw.replace("https://", "").replace("http://", "").replace("www.", "")

    if raw.startswith("*") or (raw.endswith("*") and not raw.startswith("*.")):
        return {"type": "substring", "keyword": raw.strip("*")}
    if raw.startswith("*."):
        return {"type": "domain", "domain": raw[2:]}
    return {"type": "domain", "domain": raw}


def normalise_ip(text: str) -> str:
    return text.translate(str.maketrans("oOiIlL|!", "00111111"))


def is_url_allowed(url: str, rules: list) -> bool:
    url_norm   = normalise_ip(url)
    url_domain = url_norm.split('/')[0]

    for rule in rules:
        if rule["type"] == "substring":
            if rule["keyword"] in url_norm:
                return True
        elif rule["type"] == "domain":
            allowed        = rule["domain"]
            allowed_domain = allowed.split('/')[0]
            allowed_path   = allowed[len(allowed_domain):]

            domain_match = (url_domain == allowed_domain or
                            url_domain.endswith('.' + allowed_domain))
            if not domain_match:
                continue
            if allowed_path:
                url_path = url_norm[len(url_domain):]
                if not url_path.startswith(allowed_path):
                    continue
            return True
    return False


def is_ai_url(url: str) -> bool:
    url_lower = url.lower()
    for domain in AI_DOMAINS:
        d = domain.split('/')[0]
        if url_lower == d or url_lower.endswith('.' + d) or url_lower.startswith(d + '/'):
            return True
    for kw in AI_URL_KEYWORDS:
        if kw in url_lower:
            return True
    return False


def is_ai_tab_title(text: str) -> tuple:
    t = text.lower()
    for kw in AI_TAB_KEYWORDS:
        if kw in t:
            return True, kw
    return False, None


# ============================================================
#  SINGLE IMAGE SCAN
# ============================================================

def scan_single_image(image_path, rules: list, ai_detection: bool, fast: bool = False) -> tuple:
    try:
        with open(image_path, "rb") as f:
            data = f.read()
        img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception as e:
        return None, f"Read error: {e}"

    if img is None:
        return None, "Image decode error"

    height, width = img.shape[:2]
    violations: list = []
    raw_log: list    = []

    # ── Step 1: Tab bar (AI title detection) ─────────────────
    if ai_detection:
        tab_h    = int(height * TAB_BAR_RATIO)
        tab_bar  = img[0:tab_h, 0:width]
        tab_text = ocr_region(tab_bar, upscale=4.0)
        raw_log.append(f"[TAB] {tab_text}")

        ai_hit, kw = is_ai_tab_title(tab_text)
        if ai_hit:
            violations.append({"url": f"(tab title: '{kw}')", "reason": "AI service"})

    # ── Step 2: Address bar (anchor-based URL extraction) ─────
    all_urls: set = set()
    # fast mode (live watching): one address-bar crop instead of four
    for ratio in ([0.07] if fast else ADDRESS_BAR_RATIOS):
        crop_h = int(height * ratio)
        strip  = img[0:crop_h, 0:width]
        text   = ocr_region(strip)
        raw_log.append(f"[{int(ratio*100)}%] {text}")
        urls = extract_urls_anchor(text)
        all_urls.update(urls)

    for url in all_urls:
        if ai_detection and is_ai_url(url):
            violations.append({"url": url, "reason": "AI service"})
        elif not is_url_allowed(url, rules):
            violations.append({"url": url, "reason": "Not in whitelist"})

    return violations, " | ".join(raw_log)


# ============================================================
#  DIRECTORY SCAN
# ============================================================

def scan_directory(root_folder: str, rules: list, ai_detection: bool):
    root_path = Path(root_folder)
    if not root_path.exists() or not root_path.is_dir():
        print("\n[!] Directory not found. Check the path you entered.")
        return

    valid_ext   = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'}
    image_files = [p for p in root_path.rglob('*') if p.suffix.lower() in valid_ext]

    if not image_files:
        print("\n[!] No images found in this directory.")
        return

    print(f"\nScanning {len(image_files)} image(s)...")
    print("-" * 55)

    results          = []
    total_violations = 0
    total_ai         = 0
    errors           = 0

    for i, img_path in enumerate(image_files, 1):
        print(f"[{i}/{len(image_files)}] {img_path.name} ... ", end="", flush=True)

        violations, raw_text = scan_single_image(img_path, rules, ai_detection)

        if violations is None:
            print("ERROR (could not read file)")
            errors += 1
            continue

        ai_hits    = [v for v in violations if v["reason"] == "AI service"]
        other_hits = [v for v in violations if v["reason"] != "AI service"]

        if violations:
            total_violations += 1
            if ai_hits:
                total_ai += 1
            parts = []
            if other_hits:
                parts.append(f"BLOCKED: {[v['url'] for v in other_hits]}")
            if ai_hits:
                parts.append(f"AI: {[v['url'] for v in ai_hits]}")
            print("VIOLATION! " + " | ".join(parts))
        else:
            print("OK")

        def fmt(vs):
            return ", ".join(f"{v['url']} ({v['reason']})" for v in vs) if vs else "None"

        all_found = extract_urls_anchor(raw_text)

        results.append({
            "Scan Time":      datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "File Name":      img_path.name,
            "Status":         "VIOLATION" if violations else "OK",
            "Blocked URLs":   fmt(other_hits),
            "AI URLs":        fmt(ai_hits),
            "All URLs Found": ", ".join(all_found) if all_found else "None",
            "Raw OCR Text":   raw_text,
            "Full Path":      str(img_path),
        })

    results.sort(key=lambda x: 0 if x["Status"] == "VIOLATION" else 1)

    log_file   = "exam_scan_log.csv"
    fieldnames = [
        "Scan Time", "File Name", "Status",
        "Blocked URLs", "AI URLs", "All URLs Found",
        "Raw OCR Text", "Full Path",
    ]
    with open(log_file, mode='w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)

    print("\n" + "=" * 55)
    print("                  SCAN SUMMARY")
    print("=" * 55)
    print(f"  Images scanned   : {len(image_files)}")
    print(f"  Violations found : {total_violations}")
    print(f"    of which AI    : {total_ai}")
    print(f"  Read errors      : {errors}")
    print(f"  Log saved to     : {Path(log_file).absolute()}")
    print("=" * 55)


# ============================================================
#  USER SETUP
# ============================================================

def get_allowed_rules() -> list:
    print("\n" + "=" * 55)
    print("         DEFINE ALLOWED WEBSITES FOR THE EXAM")
    print("=" * 55)
    print("Supported formats:")
    print("  tikshuv-ccna.com          domain + all subdomains")
    print("  docs.google.com/forms     only Google Forms (path match)")
    print("  google*                   any URL containing 'google'")
    print("  *moodle*                  any URL containing 'moodle'")
    print("  10.100.100.1              specific IP address")
    print()
    print("  No need to include https:// or www.")
    print("  Press Enter on an empty line when done.")
    print("-" * 55)

    rules = []
    while True:
        entry = input("  Allow: ").strip().lower()
        if not entry:
            break
        rule = parse_rule(entry)
        rules.append(rule)
        if rule["type"] == "substring":
            print(f"    -> Wildcard: any URL containing '{rule['keyword']}'")
        else:
            print(f"    -> Domain:   {rule['domain']} (+ subdomains)")

    print(f"\n  {len(rules)} allow rule(s) configured.")
    return rules


def ask_ai_detection() -> bool:
    print("\n" + "=" * 55)
    print("              AI WEBSITE DETECTION")
    print("=" * 55)
    print("  Automatically flag known AI services?")
    print("  Detects via browser tab title AND URL.")
    print("  (ChatGPT, Claude, Gemini, Copilot, Perplexity, etc.)")
    print()
    while True:
        answer = input("  Enable AI detection? [y/n]: ").strip().lower()
        if answer in ('y', 'yes'):
            print("  -> AI detection ENABLED.")
            return True
        if answer in ('n', 'no'):
            print("  -> AI detection disabled.")
            return False
        print("  Please type y or n.")


# ============================================================
#  ENTRY POINT
# ============================================================
def image_signature(path) -> tuple:
    """16x9 grayscale thumbnail; identical consecutive frames are skipped in watch mode."""
    with open(path, "rb") as f:
        img = cv2.imdecode(np.frombuffer(f.read(), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    small = cv2.resize(img, (16, 9), interpolation=cv2.INTER_AREA)
    return tuple((small // 8).flatten().tolist())    # coarse buckets -> tolerant to JPEG noise


def run_watch(args):
    from scanner_watch import watch
    rules = [parse_rule(r) for r in (args.allow or "").split(",") if r.strip()]

    def scan_fn(path):
        violations, _raw = scan_single_image(path, rules, True, fast=True)
        if violations is None:
            return None
        ai = [v["url"] for v in violations if v["reason"] == "AI service"]
        blocked = [v["url"] for v in violations if v["reason"] != "AI service"] if rules else []
        return ai, blocked

    watch(args.folder, scan_fn, image_signature, args.server, args.key,
          include_existing=args.include_existing)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Exam screenshot scanner (batch or live watch).")
    ap.add_argument("--watch", action="store_true", help="live mode: scan new screenshots and report to the server")
    ap.add_argument("--server", default="https://localhost:4555", help="exam server address")
    ap.add_argument("--key", default="", help="scannerKey from config.json (printed by the server at start-up)")
    ap.add_argument("--folder", default="screenshots", help="screenshots folder to watch")
    ap.add_argument("--allow", default="", help="comma-separated allowed sites (live mode flags others); empty = AI check only")
    ap.add_argument("--include-existing", action="store_true", help="also scan images that already exist")
    cli = ap.parse_args()
    if cli.watch:
        if not cli.key:
            raise SystemExit("--key is required in --watch mode (see the server start-up message).")
        run_watch(cli)
        raise SystemExit(0)

    allow_rules  = get_allowed_rules()
    ai_detection = ask_ai_detection()

    print("\nEnter the full path to the folder containing the screenshots:")
    folder = input("  Folder path: ").strip().strip('"').strip("'")

    scan_directory(folder, allow_rules, ai_detection)
