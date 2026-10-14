#!/usr/bin/env python3
"""Build public/data/vocab.csv from DW's official Nicos Weg lesson PDFs.

Nicos Weg currently covers A1, A2, and B1. B2 is intentionally left empty.
A1/A2 English glosses come from DW's English PDFs. The B1 PDFs contain
German definitions only, so this importer first reuses an existing local
English gloss and can translate remaining headwords when --translate-missing
is supplied. Translations are cached for deterministic later rebuilds.

Requires the `pdftotext` executable from poppler-utils.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "scripts" / "data" / "nicos-weg-pdfs.txt"
TRANSLATION_CACHE = ROOT / "scripts" / "data" / "nicos-weg-b1-english.json"
OUTPUT = ROOT / "public" / "data" / "vocab.csv"
PDF_CACHE = ROOT / ".cache" / "nicos-weg-pdfs"
LEVELS = ("A1", "A2", "B1")
LESSONS_PER_LEVEL = 76
GROUP_SIZE = 30
FIELDS = (
    "id", "group", "german", "article", "notes", "pos", "english",
    "mnemonic", "level", "example", "image",
)
ARTICLE_BY_GENDER = {"m": "der", "f": "die", "n": "das"}
NOTE_PREFIXES = (
    "abkürzung", "alternativ", "aus dem", "feminin", "hier", "kurzform",
    "maskulin", "meist", "mit ", "neutral", "nur ", "ohne ", "plural",
    "singular", "umgangssprachlich", "variante", "wird ", "zum beispiel",
    "achtung", "formell", "im präsens", "in uhrzeiten", "partizip",
)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--translate-missing", action="store_true",
                        help="translate unmatched B1 headwords using Google Translate")
    parser.add_argument("--workers", type=int, default=8,
                        help="parallel PDF downloads (default: 8)")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--pdf-cache", type=Path, default=PDF_CACHE)
    parser.add_argument("--gloss-source", type=Path,
                        help="existing CSV used only to seed B1 English glosses")
    return parser.parse_args()


def read_manifest(path: Path) -> list[str]:
    urls = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")]
    if len(urls) != len(LEVELS) * LESSONS_PER_LEVEL:
        raise RuntimeError(f"Expected 228 DW lesson URLs, found {len(urls)}")
    if any(not url.startswith("https://static.dw.com/downloads/") for url in urls):
        raise RuntimeError("Manifest contains a non-DW download URL")
    return urls


def lesson_metadata(index: int) -> tuple[str, int, int]:
    level_index, offset = divmod(index, LESSONS_PER_LEVEL)
    return LEVELS[level_index], offset // 4, offset % 4 + 1


def download_pdf(index: int, url: str, cache_dir: Path) -> Path:
    level, unit, lesson = lesson_metadata(index)
    target = cache_dir / f"{index + 1:03d}-{level.lower()}-e{unit}-l{lesson}.pdf"
    if target.exists() and target.stat().st_size > 1_000:
        return target
    request = urllib.request.Request(url, headers={"User-Agent": "Wortschatzberg/1.0"})
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read()
            if not data.startswith(b"%PDF"):
                raise RuntimeError(f"Not a PDF: {url}")
            temporary = target.with_suffix(".pdf.part")
            temporary.write_bytes(data)
            temporary.replace(target)
            return target
        except Exception as error:  # noqa: BLE001 - retry network failures
            last_error = error
            time.sleep(attempt + 1)
    raise RuntimeError(f"Could not download {url}: {last_error}")


def download_all(urls: list[str], cache_dir: Path, workers: int) -> list[Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path | None] = [None] * len(urls)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {executor.submit(download_pdf, index, url, cache_dir): index
                   for index, url in enumerate(urls)}
        for count, future in enumerate(as_completed(futures), start=1):
            index = futures[future]
            paths[index] = future.result()
            if count % 25 == 0 or count == len(urls):
                print(f"Downloaded/verified {count}/{len(urls)} lesson PDFs", flush=True)
    return [path for path in paths if path is not None]


def pdf_text(path: Path) -> str:
    result = subprocess.run(
        ["pdftotext", "-layout", str(path), "-"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return result.stdout.decode("utf-8", errors="replace")


def clean_vocabulary_section(text: str, level: str) -> str:
    markers = ("Vocabulary (from script and lesson)",) if level != "B1" else (
        "Wortschatz (aus Manuskript und Lektion)",
    )
    marker = next((candidate for candidate in markers if candidate in text), None)
    if not marker:
        raise RuntimeError(f"Vocabulary marker missing in a {level} PDF")
    section = text.split(marker, 1)[1].replace("\f", "\n\n")
    kept = []
    for raw in section.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith("Nicos Weg |"):
            continue
        if stripped in {"Script and vocabulary", "Manuskript und Wortschatz"}:
            continue
        if "Deutsch zum Mitnehmen" in stripped and "© Deutsche Welle" in stripped:
            continue
        kept.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def looks_like_note(line: str) -> bool:
    lower = line.casefold().strip()
    if lower.startswith(NOTE_PREFIXES):
        return True
    if re.fullmatch(r"[^,]+(?:er|r),\s*am\s+.+sten", lower):
        return True
    if re.search(r"\b(hat|ist)\s+[a-zäöüß|]+(?:en|t)\b", lower):
        return True
    if lower.count(",") >= 2 and not re.search(r"\b(to|the|a|an|of|for|with)\b", lower):
        return True
    return False


def parse_blocks(section: str, level: str) -> list[dict[str, str]]:
    entries = []
    for block in re.split(r"\n\s*\n+", section):
        lines = [re.sub(r"\s+", " ", line).strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        dash_line = next((index for index, line in enumerate(lines) if " – " in line), None)
        if dash_line is None:
            continue
        leading = " ".join(lines[:dash_line + 1])
        left, right = leading.split(" – ", 1)
        continuations = lines[dash_line + 1:]
        if level != "B1":
            english_parts = [right]
            notes = []
            for line in continuations:
                if notes or looks_like_note(line):
                    notes.append(line)
                else:
                    english_parts.append(line)
            english = " ".join(english_parts).strip()
            definition = ""
        else:
            english = ""
            definition = " ".join([right, *continuations]).strip()
            notes = []
        left = re.sub(r"\s+", " ", left).strip()
        if left and (english or definition):
            entries.append({"headword": left, "english": english,
                            "definition": definition, "grammar": "; ".join(notes)})
    return entries


def split_headword(raw: str) -> tuple[str, str, str]:
    value = raw.strip().rstrip(".;")
    article = ""
    notes = []
    gender_match = re.search(r"\s*\(([mfn])\.(?:,[^)]*)?\)\s*$", value)
    if gender_match:
        article = ARTICLE_BY_GENDER[gender_match.group(1)]
        value = value[:gender_match.start()].strip()
    trailing_note = re.search(r"\s*\(([^()]*)\)\s*$", value)
    if trailing_note and looks_like_note(trailing_note.group(1)):
        notes.append(trailing_note.group(1).strip())
        value = value[:trailing_note.start()].strip()
    article_match = re.match(r"^(der|die|das)\s+(.+)$", value, re.IGNORECASE)
    if article_match:
        article = article_match.group(1).lower()
        value = article_match.group(2).strip()
    if "," in value and (article or re.search(r",\s*-", value)):
        lemma, plural = value.split(",", 1)
        if lemma.strip() and plural.strip():
            value = lemma.strip()
            notes.append(f"Plural/Formen: {plural.strip()}")
    return value, article, "; ".join(notes)


def normalize_key(value: str) -> str:
    value = value.casefold().replace("|", "")
    value = re.sub(r"\([^)]*\)", " ", value)
    value = re.sub(r"^(der|die|das)\s+", "", value)
    return re.sub(r"[^a-zäöüß0-9]+", " ", value).strip()


def lookup_keys(value: str) -> list[str]:
    base = normalize_key(value)
    simplified = re.sub(
        r"^(sich|etwas|jemanden|jemandem|jemand|einer sache|eine sache)\s+", "", base,
    )
    return list(dict.fromkeys(key for key in (base, simplified) if key))


def existing_glosses(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    result = {}
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            english = str(row.get("english", "")).strip()
            if not english:
                continue
            german = " ".join(part for part in (row.get("article", ""), row.get("german", "")) if part)
            for key in lookup_keys(german):
                result.setdefault(key, english)
    return result


def load_translation_cache() -> dict[str, str]:
    if not TRANSLATION_CACHE.exists():
        return {}
    value = json.loads(TRANSLATION_CACHE.read_text(encoding="utf-8"))
    return {str(key): str(translation) for key, translation in value.items() if translation}


def save_translation_cache(cache: dict[str, str]) -> None:
    TRANSLATION_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TRANSLATION_CACHE.write_text(
        json.dumps(dict(sorted(cache.items())), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def translate_headword(text: str) -> str:
    query = urllib.parse.urlencode({
        "client": "gtx", "sl": "de", "tl": "en", "dt": "t", "q": text.replace("|", ""),
    })
    url = f"https://translate.googleapis.com/translate_a/single?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "Wortschatzberg/1.0"})
    last_error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
            translation = "".join(part[0] for part in payload[0] if part and part[0]).strip()
            if translation:
                return translation
        except Exception as error:  # noqa: BLE001 - retry public translation service
            last_error = error
            time.sleep(attempt + 1)
    raise RuntimeError(f"Could not translate {text!r}: {last_error}")


def translate_missing(headwords: list[str], cache: dict[str, str], workers: int) -> None:
    missing = sorted(set(headword for headword in headwords if headword not in cache))
    if not missing:
        return
    with ThreadPoolExecutor(max_workers=min(4, max(1, workers))) as executor:
        futures = {executor.submit(translate_headword, headword): headword for headword in missing}
        for count, future in enumerate(as_completed(futures), start=1):
            headword = futures[future]
            cache[headword] = future.result()
            if count % 50 == 0 or count == len(missing):
                print(f"Translated {count}/{len(missing)} unmatched B1 headwords", flush=True)
    save_translation_cache(cache)


def infer_pos(german: str, article: str, grammar: str, fallback: str = "") -> str:
    if article:
        return "noun"
    if fallback in {"noun", "verb", "adjective", "adverb", "preposition", "other"}:
        return fallback
    plain = german.replace("|", "").strip().casefold()
    last = plain.split()[-1] if plain.split() else ""
    if last.endswith("en") or plain.startswith(("sich ", "etwas ", "jemanden ", "jemandem ")):
        return "verb"
    if "am " in grammar.casefold() and "sten" in grammar.casefold():
        return "adjective"
    if " " in plain or german.endswith(('.', '?', '!')):
        return "other"
    return "other"


def build_rows(paths: list[Path], old_rows_path: Path, translate: bool, workers: int) -> list[dict[str, str]]:
    old_glosses = existing_glosses(old_rows_path)
    old_pos = {}
    if old_rows_path.exists():
        with old_rows_path.open(encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                for key in lookup_keys(row.get("german", "")):
                    old_pos.setdefault(key, row.get("pos", ""))
    cache = load_translation_cache()
    parsed = []
    for index, path in enumerate(paths):
        level, unit, lesson = lesson_metadata(index)
        section = clean_vocabulary_section(pdf_text(path), level)
        entries = parse_blocks(section, level)
        if not entries:
            raise RuntimeError(f"No vocabulary parsed from {path.name}")
        for entry in entries:
            german, article, form_notes = split_headword(entry["headword"])
            source = f"DW Nicos Weg {level} · Einheit {unit}, Lektion {lesson}"
            notes = "; ".join(part for part in (source, form_notes, entry["grammar"]) if part)
            parsed.append({**entry, "german": german, "article": article,
                           "notes": notes, "level": level})
    b1_missing = []
    for entry in parsed:
        if entry["level"] != "B1":
            continue
        keys = lookup_keys(entry["german"])
        existing = next((old_glosses[key] for key in keys if key in old_glosses), "")
        if entry["german"] in cache:
            entry["english"] = cache[entry["german"]]
        elif existing:
            entry["english"] = existing
        else:
            b1_missing.append(entry["german"])
    if b1_missing and translate:
        translate_missing(b1_missing, cache, workers)
        for entry in parsed:
            if entry["level"] == "B1" and not entry["english"]:
                entry["english"] = cache.get(entry["german"], "")
    unresolved = sorted({entry["german"] for entry in parsed if not entry["english"]})
    if unresolved:
        sample = ", ".join(repr(item) for item in unresolved[:10])
        raise RuntimeError(
            f"{len(unresolved)} entries have no English gloss ({sample}). "
            "Run again with --translate-missing."
        )
    save_translation_cache({
        entry["german"]: entry["english"]
        for entry in parsed if entry["level"] == "B1"
    })

    unique = []
    seen = {}
    for entry in parsed:
        key = normalize_key(entry["german"])
        if not key:
            continue
        if key in seen:
            previous = seen[key]
            meanings = [part.strip() for part in previous["english"].split(";") if part.strip()]
            for meaning in (part.strip() for part in entry["english"].split(";") if part.strip()):
                if meaning not in meanings:
                    meanings.append(meaning)
            previous["english"] = "; ".join(meanings)
            if not previous["article"] and entry["article"]:
                previous["article"] = entry["article"]
                previous["pos"] = "noun"
            continue
        fallback_pos = next((old_pos[item] for item in lookup_keys(entry["german"]) if item in old_pos), "")
        row = {
            "id": "", "group": "", "german": entry["german"], "article": entry["article"],
            "notes": entry["notes"], "pos": infer_pos(entry["german"], entry["article"], entry["grammar"], fallback_pos),
            "english": entry["english"], "mnemonic": "", "level": entry["level"],
            "example": "", "image": "",
        }
        unique.append(row)
        seen[key] = row
    for index, row in enumerate(unique, start=1):
        row["id"] = f"nw-{index:04d}"
        row["group"] = str(math.ceil(index / GROUP_SIZE))
    return unique


def validate(rows: list[dict[str, str]]) -> Counter:
    levels = Counter(row["level"] for row in rows)
    if len(rows) < 1_000:
        raise RuntimeError(f"Suspiciously small import: {len(rows)} entries")
    if any(levels[level] < 250 for level in LEVELS):
        raise RuntimeError(f"A course level parsed too few entries: {dict(levels)}")
    if levels.get("B2", 0):
        raise RuntimeError("B2 must remain empty until an official source is selected")
    if any(not row["german"] or not row["english"] for row in rows):
        raise RuntimeError("Every imported row needs German and English text")
    if len({row["id"] for row in rows}) != len(rows):
        raise RuntimeError("Imported IDs are not unique")
    return levels


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="", dir=path.parent, delete=False, suffix=".csv.tmp"
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
        temporary = Path(handle.name)
    os.replace(temporary, path)
    path.chmod(0o644)


def main() -> None:
    args = arguments()
    if not shutil.which("pdftotext"):
        raise SystemExit("pdftotext is required; install poppler-utils")
    urls = read_manifest(args.manifest)
    paths = download_all(urls, args.pdf_cache, args.workers)
    rows = build_rows(paths, args.gloss_source or args.output, args.translate_missing, args.workers)
    counts = validate(rows)
    write_csv(args.output, rows)
    print(f"Wrote {len(rows)} unique Nicos Weg entries to {args.output}")
    print("Levels: " + ", ".join(f"{level}={counts.get(level, 0)}" for level in (*LEVELS, "B2")))


if __name__ == "__main__":
    main()
