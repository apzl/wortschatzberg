"""
Enrich vocab.csv with AI-generated mnemonics and example sentences via OpenRouter.

Usage:
    export OPENROUTER_KEY=sk-or-...
    python3 scripts/enrich_mnemonics.py

Fills empty mnemonic / example fields. Safe to interrupt and re-run.
"""

import csv
import os
import re
import sys
import time
import urllib.request
import urllib.error
import json
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parents[1] / "public" / "data" / "vocab.csv"
MODEL = "openai/gpt-oss-120b:free"
API_URL = "https://openrouter.ai/api/v1/chat/completions"
BATCH_SIZE = 10  # words per API request

# Enrichable fields and the per-field instructions used to build the prompt.
# Examples come from the Tatoeba dictionary (see fetch_examples.py) — the LLM is
# used only for mnemonics, which can't be sourced from a dictionary.
FIELD_SPECS = {
    "mnemonic": (
        "Mnemonic rules:\n"
        "- Use the word's Latin/Germanic root, OR an English word with similar sound/spelling, OR both\n"
        "- Tie it to the English meaning through vivid imagery or wordplay\n"
        '- Max 1–2 sentences. Do NOT prefix with "Mnemonic:"'
    ),
}


def get_api_key():
    key = os.environ.get("OPENROUTER_KEY", "").strip()
    if not key:
        sys.exit(
            "Error: OPENROUTER_KEY is not set.\n"
            "Run: export OPENROUTER_KEY=sk-or-...\n"
            "Or add it to .env and run: source .env"
        )
    return key


def build_batch_prompt(batch, fields):
    """Build a prompt asking for the given fields (e.g. {"mnemonic","example"})."""
    lines = []
    for row in batch:
        descriptor = row.get("pos", "")
        if row.get("article"):
            descriptor += f", {row['article']}"
        lines.append(
            f'- id={row["id"]}: "{row["german"]}" ({descriptor}) — means "{row["english"]}"'
        )
    word_block = "\n".join(lines)

    what = " and ".join(f"one {f}" for f in fields)
    rules = "\n".join(FIELD_SPECS[f] for f in fields)
    json_keys = ", ".join(['"id": "..."'] + [f'"{f}": "..."' for f in fields])
    return (
        f"You are a German vocabulary tutor. For EACH word below, create {what}.\n"
        f"{rules}\n\n"
        "Return the matching id verbatim for each word.\n"
        "Respond with ONLY a JSON object of the form "
        f'{{"results": [{{{json_keys}}}]}} and nothing else.\n\n'
        "Words:\n"
        f"{word_block}"
    )


def _extract_json(content):
    """Pull a JSON object out of a model response, tolerating ``` fences."""
    content = content.strip()
    if content.startswith("```"):
        # strip ```json ... ``` or ``` ... ``` fences
        content = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", content).strip()
    start, end = content.find("{"), content.rfind("}")
    if start != -1 and end != -1 and end > start:
        content = content[start:end + 1]
    return json.loads(content)


# gpt-oss free providers intermittently emit malformed "harmony" output that the
# upstream parser rejects — these are transient and worth retrying.
_TRANSIENT_RE = re.compile(
    r"upstream|openinference|unexpected tokens|message header|overloaded|"
    r"temporarily|try again|timeout|50[23]", re.I,
)


def _on_error(text, retry, prompt, api_key):
    """React to an API error: retry transient ones, otherwise give up."""
    if retry and _TRANSIENT_RE.search(text):
        print("  transient upstream error, retrying…", flush=True)
        time.sleep(2)
        return call_openrouter(prompt, api_key, retry=False)
    print(f"  API error: {text[:200]}", flush=True)
    return {}


def call_openrouter(prompt, api_key, retry=True):
    """Send one batch prompt; return {id: {field: value}} (or {} on failure)."""
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 3000,
        "temperature": 0.7,
    }).encode()
    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/wortschatzberg",
            "X-Title": "Wortschatzberg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        # OpenRouter may return HTTP 200 with an {"error": ...} body.
        if "error" in data:
            err = data["error"]
            msg = err.get("message", err) if isinstance(err, dict) else err
            return _on_error(str(msg), retry, prompt, api_key)
        if "choices" not in data:
            print(f"  unexpected response: {json.dumps(data)[:300]}", flush=True)
            return {}
        parsed = _extract_json(data["choices"][0]["message"]["content"])
        out = {}
        for item in parsed.get("results", []):
            if item.get("id") is None:
                continue
            out[str(item["id"])] = {
                f: (item.get(f) or "").strip() for f in FIELD_SPECS
            }
        return out
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode(errors="replace")
        if e.code == 429 and retry:
            print("  rate limited, waiting 2 s…", flush=True)
            time.sleep(2)
            return call_openrouter(prompt, api_key, retry=False)
        return _on_error(f"HTTP {e.code}: {body_txt}", retry, prompt, api_key)
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        # Malformed JSON content — often a transient garbled response; retry once.
        if retry:
            print(f"  bad response ({e}), retrying…", flush=True)
            time.sleep(1)
            return call_openrouter(prompt, api_key, retry=False)
        print(f"  parse error: {e}", flush=True)
        return {}
    except Exception as e:
        print(f"  error: {e}", flush=True)
        return {}


def write_csv(path, fieldnames, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


USAGE = (
    "Usage: python3 scripts/enrich_mnemonics.py --mnemonics [--dry-run]\n"
    "  --mnemonics   generate mnemonics for words missing one (required)\n"
    "  --dry-run     process one batch and print results without writing\n"
    "(Example sentences are sourced separately via fetch_examples.py.)"
)


FLAG_TO_FIELD = {"--mnemonics": "mnemonic"}


def parse_args(argv):
    fields = [field for flag, field in FLAG_TO_FIELD.items() if flag in argv]
    return fields, "--dry-run" in argv


def main():
    fields, dry_run = parse_args(sys.argv[1:])
    if not fields:
        sys.exit(USAGE)
    api_key = get_api_key()

    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    for col in fields:
        if col not in fieldnames:
            fieldnames.append(col)
        for row in rows:
            row.setdefault(col, "")

    def needs_work(r):
        return any(not r.get(f, "").strip() for f in fields)

    total = len(rows)
    todo = [r for r in rows if needs_work(r)]
    print(f"{total} words total, {len(todo)} need {'+'.join(fields)} "
          f"({BATCH_SIZE} per request)", flush=True)
    if dry_run:
        print("DRY RUN: one batch, no CSV write\n", flush=True)
        todo = todo[:BATCH_SIZE]

    done = 0
    for start in range(0, len(todo), BATCH_SIZE):
        batch = todo[start:start + BATCH_SIZE]
        prompt = build_batch_prompt(batch, fields)
        results = call_openrouter(prompt, api_key)

        got = 0
        for row in batch:
            res = results.get(str(row["id"]))
            if not res:
                continue
            # Only fill requested fields that are currently empty.
            for f in fields:
                if not row.get(f, "").strip() and res.get(f):
                    row[f] = res[f]
            if not needs_work(row):
                got += 1
        if dry_run:
            for row in batch:
                print(f"  {row['german']} ({row['english']})", flush=True)
                for f in fields:
                    print(f"    {f}: {row.get(f, '') or '—'}", flush=True)
            print(f"\nDRY RUN complete: {got}/{len(batch)} fully enriched. "
                  "Nothing written.", flush=True)
            return
        write_csv(CSV_PATH, fieldnames, rows)  # checkpoint after each batch
        done += got
        print(f"[{done}/{len(todo)}] batch of {len(batch)} → {got} complete", flush=True)

    print("Done.", flush=True)


if __name__ == "__main__":
    main()
