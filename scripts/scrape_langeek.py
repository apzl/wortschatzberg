"""
Scrape LanGeek A1-B2 German vocabulary and merge non-duplicate words into vocab.csv.
After this script finishes, re-run scripts/enrich_mnemonics.py to fill mnemonics for new entries.

LanGeek is a Next.js app: all word data is embedded in a __NEXT_DATA__ JSON blob,
not in the rendered HTML. We parse that JSON rather than scraping markup.

Usage:
    python3 scripts/scrape_langeek.py

No extra dependencies — uses urllib and json from stdlib.
"""

import csv
import re
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE_URL = "https://langeek.co"
CSV_PATH = Path(__file__).resolve().parents[1] / "public" / "data" / "vocab.csv"
GROUP_SIZE = 50
REQUEST_DELAY = 1.0  # seconds between requests — be polite

LEVEL_CATEGORIES = [
    ("A1", "/de-EN/vocab/category/467/a1-stufe"),
    ("A2", "/de-EN/vocab/category/472/a2-stufe"),
    ("B1", "/de-EN/vocab/category/473/b1-stufe"),
    ("B2", "/de-EN/vocab/category/520/b2-stufe"),
]

_ARTICLES = {"der", "die", "das"}
_GENDER_ARTICLE = {"masculine": "der", "feminine": "die", "neuter": "das", "neutral": "das"}

# Map LanGeek POS labels to the app's five categories
_POS_MAP = {
    "noun": "noun", "verb": "verb", "adjective": "adjective",
    "adverb": "adverb", "preposition": "preposition",
    "interjection": "other", "particle": "other", "sentence": "other",
    "pronoun": "other", "article": "other", "conjunction": "other",
    "numeral": "other", "determiner": "other", "phrase": "other",
    "abbreviation": "other", "prefix": "other", "suffix": "other",
}


# ---------- HTTP ----------

def _fetch(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; Wortschatzberg-scraper/1.0)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {url}", flush=True)
        return ""
    except Exception as e:
        print(f"  error fetching {url}: {e}", flush=True)
        return ""


# ---------- HTML parsing ----------

def _next_data(html):
    """Extract and parse the __NEXT_DATA__ JSON blob from a LanGeek page."""
    m = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html, re.DOTALL,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def _get_subcategory_ids(category_path):
    html = _fetch(BASE_URL + category_path)
    ids = list(dict.fromkeys(
        re.findall(r'/de-EN/vocab/subcategory/(\d+)/', html)
    ))
    return ids


def _parse_word_list(html):
    """Return a list of word dicts from a LanGeek /word-list page's JSON."""
    data = _next_data(html)
    if not data:
        return []
    try:
        cards = data["props"]["pageProps"]["initialState"]["static"]["subcategory"]["cards"]
    except (KeyError, TypeError):
        return []

    words = []
    for card in cards:
        mt = card.get("mainTranslation") or {}
        title = (mt.get("title") or "").strip()
        if not title:
            continue

        # Article is usually embedded in the title ("die Hilfe"); otherwise
        # derive it from the noun's gender.
        parts = title.split(None, 1)
        if len(parts) == 2 and parts[0].lower() in _ARTICLES:
            article, german = parts[0].lower(), parts[1]
        else:
            article, german = "", title
            gi = (mt.get("partOfSpeech") or {}).get("grammaticalInformation") or {}
            gender = (gi.get("gender") or "").lower()
            if gender in _GENDER_ARTICLE:
                article = _GENDER_ARTICLE[gender]
        if not german:
            continue

        english = ((mt.get("localizedProperties") or {}).get("translation") or "").strip()
        if not english:
            continue

        pos_raw = ((mt.get("partOfSpeech") or {}).get("partOfSpeechType") or "").lower()
        pos = _POS_MAP.get(pos_raw, "other")

        photo = mt.get("wordPhoto") or {}
        image = (photo.get("photoThumbnail") or photo.get("photo") or "").strip()

        # German definition serves as a short hint (no example sentences exist
        # in the listing data — those live only on per-word detail pages).
        notes = (mt.get("translation") or "").strip()

        words.append({
            "german": german,
            "article": article,
            "english": english,
            "pos": pos,
            "notes": notes,
            "image": image,
        })

    return words


# ---------- dedup ----------

def _key(word):
    """Normalised German word for dedup comparison."""
    w = word.strip().lower()
    parts = w.split(None, 1)
    if len(parts) == 2 and parts[0] in _ARTICLES:
        return parts[1]
    return w


# ---------- main ----------

def main():
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    # Add new columns to existing rows
    for col in ("level", "example", "image"):
        if col not in fieldnames:
            fieldnames.append(col)
    for row in rows:
        if not row.get("level"):
            row["level"] = "B2"
        row.setdefault("example", "")
        row.setdefault("image", "")

    existing_keys = {_key(r["german"]) for r in rows}
    max_id = max((int(r["id"]) for r in rows), default=0)
    max_group = max((int(r["group"]) for r in rows), default=0)

    new_words = []

    for level, cat_path in LEVEL_CATEGORIES:
        print(f"\n=== {level} ===", flush=True)
        sub_ids = _get_subcategory_ids(cat_path)
        print(f"  {len(sub_ids)} subcategories", flush=True)
        time.sleep(REQUEST_DELAY)

        for j, sub_id in enumerate(sub_ids):
            url = f"{BASE_URL}/de-EN/vocab/subcategory/{sub_id}/word-list"
            html = _fetch(url)
            parsed = _parse_word_list(html)
            added = 0
            for w in parsed:
                k = _key(w["german"])
                if k in existing_keys:
                    continue
                existing_keys.add(k)
                max_id += 1
                # Start a new group every GROUP_SIZE words
                if not new_words or len(new_words) % GROUP_SIZE == 0:
                    max_group += 1
                new_words.append({
                    "id": max_id,
                    "group": max_group,
                    "level": level,
                    "german": w["german"],
                    "article": w["article"],
                    "notes": w["notes"],
                    "pos": w["pos"],
                    "english": w["english"],
                    "mnemonic": "",
                    "example": "",
                    "image": w["image"],
                })
                added += 1
            print(
                f"  [{j + 1}/{len(sub_ids)}] sub {sub_id}: "
                f"{len(parsed)} parsed, {added} new",
                flush=True,
            )
            time.sleep(REQUEST_DELAY)

    if not new_words:
        print("\nNo new words found — vocab.csv unchanged.", flush=True)
        # Still write back to persist the new columns on existing rows
    else:
        print(f"\n{len(new_words)} new words to add.", flush=True)

    all_rows = rows + new_words
    for row in all_rows:
        for col in fieldnames:
            row.setdefault(col, "")

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"vocab.csv: {len(all_rows)} total words.", flush=True)
    if new_words:
        print("Run python3 scripts/enrich_mnemonics.py to fill mnemonics for new words.", flush=True)


if __name__ == "__main__":
    main()
