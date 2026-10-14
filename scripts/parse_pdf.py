#!/usr/bin/env python3
"""Parse the B2 German vocab PDF into vocab.csv.

Source format per entry (one per numbered item, sometimes wrapped over lines):
    N). <German term> (<info>) - <English translation>

We derive:
    id        sequential 1..N
    group     mountain level = ceil(id / GROUP_SIZE)
    german    German term, article stripped into its own column
    article   der | die | das  (empty for non-nouns)
    notes     the parenthetical content (plural ending, past participle, etc.)
    pos       noun | verb | adjective | adverb | preposition | other
    english   English translation

Run:  python3 scripts/parse_pdf.py "/path/to/B2 Vocab.pdf"
"""
import csv
import math
import re
import sys
from pathlib import Path
from pypdf import PdfReader

GROUP_SIZE = 50  # words per mountain level

PDF = sys.argv[1] if len(sys.argv) > 1 else "/mnt/c/Users/apsal/Downloads/B2 Vocab.pdf"
OUT = Path(__file__).resolve().parents[1] / "public" / "data" / "vocab.csv"

# Markers inside the parenthetical that name a part of speech.
POS_MARKERS = {
    "adj": "adjective",
    "adv": "adverb",
    "prep": "preposition",
    "conj": "conjunction",
    "pron": "pronoun",
}


def fix_artifacts(s: str) -> str:
    """Repair PDF extraction glitches like 'V ollmacht' -> 'Vollmacht'."""
    s = s.replace(" ", " ")
    # A lone capital letter split from the rest of its word.
    s = re.sub(r"\b([A-ZÄÖÜ]) (?=[a-zäöüß]{2,})", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def split_entries(raw_lines):
    """Merge wrapped lines so each entry starts with 'N).'."""
    entries = []
    cur = None
    num_re = re.compile(r"^\s*(\d+)\s*\)\s*\.?\s*(.*)$")
    for line in raw_lines:
        if not line.strip():
            continue
        m = num_re.match(line)
        if m:
            if cur:
                entries.append(cur)
            cur = (int(m.group(1)), m.group(2).strip())
        elif cur:
            cur = (cur[0], (cur[1] + " " + line.strip()).strip())
    if cur:
        entries.append(cur)
    return entries


def classify(article, notes, german, english):
    """Best-effort part-of-speech tag."""
    low_notes = notes.lower()
    for marker, pos in POS_MARKERS.items():
        if re.search(rf"\b{marker}\b", low_notes):
            return pos
    if article:
        return "noun"
    # Past-participle hint in the parenthetical => verb.
    if notes and (re.search(r"\bge\w+t?\b", low_notes) or notes.endswith(("t", "en"))):
        if not german[:1].isupper() or english.lower().startswith("to "):
            return "verb"
    # English "to ..." strongly implies a verb.
    if english.lower().startswith("to "):
        return "verb"
    # Capitalised German word with no article is usually still a noun.
    if german[:1].isupper():
        return "noun"
    return "other"


def parse():
    reader = PdfReader(PDF)
    text = "\n".join(p.extract_text() or "" for p in reader.pages)
    entries = split_entries(text.splitlines())

    # A dash that has whitespace on at least one side = the main divider.
    # (Avoids splitting inside hyphenated compounds, which have no spaces.)
    spaced_dash = re.compile(r"\s+[–-]\s*|\s*[–-]\s+")
    # Fallback when there is no spaced dash: German, then a parenthetical.
    # Text after the paren is the translation; if nothing follows, the paren
    # itself holds the translation (common for whole-phrase entries).
    paren_split = re.compile(r"^(.*?)\(([^)]*)\)\s*(.*)$")
    rows, skipped = [], []

    def take_paren(s):
        """Return (text_without_paren, paren_contents)."""
        m = re.search(r"\(([^)]*)\)", s)
        if not m:
            return s.strip(), ""
        return re.sub(r"\s*\([^)]*\)\s*", " ", s).strip(), m.group(1).strip()

    for _num, body in entries:
        body = fix_artifacts(body)

        notes = ""
        m = spaced_dash.search(body)
        if m:
            german_side, english = body[:m.start()].strip(), body[m.end():].strip()
        else:
            pm = paren_split.match(body)
            if pm and pm.group(3).strip():           # German (info) English
                german_side, english = pm.group(1).strip(), pm.group(3).strip()
            elif pm:                                  # German phrase (English)
                german_side, english, notes = pm.group(1).strip(), pm.group(2).strip(), ""
            else:
                parts = re.split(r"\s{2,}", body, maxsplit=1)
                if len(parts) == 2:
                    german_side, english = parts[0].strip(), parts[1].strip()
                else:
                    # Last resort: article + noun (or one word) is German.
                    fm = re.match(r"^((?:der|die|das)\s+)?\S+", body, re.IGNORECASE)
                    if fm and body[fm.end():].strip():
                        german_side, english = fm.group(0).strip(), body[fm.end():].strip()
                    else:
                        skipped.append(body)
                        continue

        english = english.lstrip("–-").strip()
        if not german_side or not english:
            skipped.append(body)
            continue

        # Parenthetical (plural / participle / pos) may sit on either side.
        if not notes:
            german_side, notes = take_paren(german_side)
        if not notes:
            english, notes = take_paren(english)

        # Split off a leading article.
        article = ""
        am = re.match(r"^(der|die|das)\b\s+(.*)$", german_side, re.IGNORECASE)
        if am:
            article = am.group(1).lower()
            german = am.group(2).strip()
        else:
            german = german_side

        if not german:
            skipped.append(body)
            continue

        pos = classify(article, notes, german, english)
        rows.append({"german": german, "article": article,
                     "notes": notes, "pos": pos, "english": english})

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "group", "german", "article", "notes", "pos", "english"])
        for i, r in enumerate(rows, 1):
            group = math.ceil(i / GROUP_SIZE)
            w.writerow([i, group, r["german"], r["article"],
                        r["notes"], r["pos"], r["english"]])

    print(f"Parsed {len(rows)} entries into {OUT} "
          f"({math.ceil(len(rows) / GROUP_SIZE)} groups).")
    if skipped:
        print(f"Skipped {len(skipped)} unparseable lines:")
        for s in skipped[:15]:
            print("  -", repr(s))


if __name__ == "__main__":
    parse()
