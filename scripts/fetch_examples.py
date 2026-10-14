"""
Fill the `example` column in vocab.csv with German sentences + English
translations sourced from the free Tatoeba API (no API key, no LLM).

Usage:
    python3 scripts/fetch_examples.py [--dry-run] [--limit N]
        --dry-run   look up the first 10 words and print results, no write
        --limit N   only process the first N words needing an example

Skips rows that already have an example. Safe to interrupt and re-run.
"""

import csv
import sys
import time
import json
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parents[1] / "public" / "data" / "vocab.csv"
API_URL = "https://tatoeba.org/en/api_v0/search"
REQUEST_DELAY = 0.5  # seconds between requests — be polite
CHECKPOINT_EVERY = 25  # write CSV every N lookups

_ARTICLES = {"der", "die", "das"}


def query_word(word):
    """Strip a leading article so nouns query on the bare lemma."""
    parts = word.split(None, 1)
    if len(parts) == 2 and parts[0].lower() in _ARTICLES:
        return parts[1]
    return word


def fetch(word):
    url = API_URL + "?" + urllib.parse.urlencode(
        {"from": "deu", "to": "eng", "query": word, "sort": "relevance"}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r).get("results", [])
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("  rate limited, waiting 5 s…", flush=True)
            time.sleep(5)
        else:
            print(f"  HTTP {e.code} for {word!r}", flush=True)
        return []
    except Exception as e:
        print(f"  error for {word!r}: {e}", flush=True)
        return []


def _english_translation(result):
    flat = [t for grp in result.get("translations", []) for t in grp]
    eng = [t["text"] for t in flat if t.get("lang") == "eng" and t.get("text")]
    return eng[0] if eng else None


def pick_example(results, word):
    """Choose the most useful German sentence + English translation, or None."""
    w = query_word(word).lower()
    best, best_score = None, -1
    for res in results:
        de = (res.get("text") or "").strip()
        en = _english_translation(res)
        if not de or not en:
            continue
        score = 0
        if w in de.lower():       # sentence actually uses the word
            score += 3
        length = len(de)
        if 15 <= length <= 100:   # a real, readable sentence
            score += 2
        elif length < 15:
            score -= 1
        if score > best_score:
            best_score, best = score, (de, en)
    if not best:
        return None
    de, en = best
    return f"{de} ({en})"


def write_csv(path, fieldnames, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    dry_run = "--dry-run" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        i = sys.argv.index("--limit")
        limit = int(sys.argv[i + 1])

    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    if "example" not in fieldnames:
        fieldnames.append("example")
    for row in rows:
        row.setdefault("example", "")

    todo = [r for r in rows if not r.get("example", "").strip()]
    if dry_run:
        todo = todo[:10]
    elif limit:
        todo = todo[:limit]

    print(f"{len(rows)} words total, processing {len(todo)} "
          f"(missing examples){' — DRY RUN' if dry_run else ''}", flush=True)

    found = 0
    for i, row in enumerate(todo, 1):
        example = pick_example(fetch(row["german"]), row["german"]) or ""
        if example:
            found += 1
        if dry_run:
            print(f"  {row['german']} → {example or '— (no match)'}", flush=True)
        else:
            row["example"] = example
            if i % CHECKPOINT_EVERY == 0:
                write_csv(CSV_PATH, fieldnames, rows)
                print(f"[{i}/{len(todo)}] {found} examples found "
                      f"(checkpoint)", flush=True)
        time.sleep(REQUEST_DELAY)

    if dry_run:
        print(f"\nDRY RUN complete: {found}/{len(todo)} matched. Nothing written.",
              flush=True)
        return

    write_csv(CSV_PATH, fieldnames, rows)
    print(f"Done. {found}/{len(todo)} examples added.", flush=True)


if __name__ == "__main__":
    main()
