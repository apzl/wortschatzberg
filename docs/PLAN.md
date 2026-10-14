# Wortschatzberg — Alle-Gruppen board plan

Updated: 2026-10-14. This is the active product scope.

Wortschatzberg has one primary view: `Alle Gruppen`. Do not add or restore a
separate daily-plan tab, calendar-style study screen, or
automatic catch-up queue. The group board is the place where users filter,
select, inspect, mark, test, and shuffle vocabulary.

## 1. Product decision

Keep the German vocabulary board visible and controllable. Users choose the
level combination and inclusive group range, then study visible words in their
chosen order. German → English remains the default presentation; English →
German is available as an explicit direction for production practice.

Spaced-review state may remain stored for migration and future scheduling, but
the current UI must not force a daily workflow. Green/red/clear board marks
remain direct practice marks. Do not silently turn a board click into a daily
assignment or mandatory review queue.

## 2. Scope and non-goals

### In scope

- A single `Alle Gruppen` view with a clear header and settings entry.
- Inclusive start/end group filters and CEFR level multi-select.
- Group reconstruction from selected levels, with balanced groups of at least
  30 words whenever enough words exist.
- Within-group shuffle, whole-list shuffle, and reset ordering.
- Seven columns on wide desktop; later groups flow below the first seven.
- Responsive four-column, two-column, and one-column layouts; never a
  horizontal-only group strip.
- German/article-only library rows. Do not render examples, images, grammar,
  mnemonics, or hidden answer text inside rows.
- I/J/K/L and arrow navigation, with empty groups skipped horizontally.
- G/R/W row marking, T target toggling, D-only detail opening, and any-key
  detail dismissal with held-key protection.
- A centered, blurred-background detail popup with visible close and speech
  controls, plus a separate note editor that accepts normal typing.
- Group tests and the 60-second sprint as clearly labeled practice; practice
  must not advance scheduled review intervals.
- Browser-local JSON export/import, validated recovery, stale-tab protection,
  schedule reset, and confirmed full local-data reset.
- A reproducible vocabulary import from DW Nicos Weg: A1, A2, and B1 are
  populated from the official lesson materials; B2 stays visible but empty.

### Explicitly out of scope

- Any second top-level learning view.
- Daily group allocation, tomorrow summaries, daily carry-over UI, daily retry
  queues, or automatic session resumption from the board.
- Accounts, cloud sync, backend services, AI grading, ad-hoc vocabulary
  scraping, automatic CEFR reassignment, framework rewrites, or a new runtime
  dependency.

## 3. Single-board layout

Use the existing white background, system font, thin borders, and blue accents.
The header is:

```text
Wortschatzberg                         [Alle Gruppen] [Einstellungen]

[Stufen: Alle A1 A2 B1 B2] [Gruppe von] [bis] [Zielliste]
[In Gruppen mischen] [Gesamtliste mischen] [Reihenfolge] [Sprint]
```

The board is the default and only primary route. `Alle Gruppen` is the visible
active navigation item. Clicking the brand returns to this board.

Each group header shows its number, word count, due/status count when useful,
and a group-test action. Rows show one prompt only: German plus article in the
library. Long compounds may wrap; never truncate the word.

### Responsive board

- At viewport widths ≥1440px, render exactly seven equal columns per row.
- At 1000–1439px, render four columns.
- At 700–999px, render two columns.
- Below 700px, render one column.
- Additional groups continue vertically in DOM order.
- Keep words at least 15px with desktop row height about 36px and mobile row
  height about 44px.
- Keep selected-row blue outlines visible over green/red row backgrounds.

## 4. Filters, levels, groups, and order

- `Gruppe von` and `bis` are inclusive numeric group indices.
- The board may show groups from the selected start through selected end; the
  range is never treated as a calendar date.
- Selecting only A1 rebuilds groups from A1 words. Selecting A1+A2 rebuilds
  mixed groups from both levels while keeping total group size stable.
- B2 remains a selectable empty filter until a separate approved B2 source is
  chosen; do not synthesize or relabel Nicos Weg words as B2.
- Multiple level checkboxes are allowed simultaneously. `Alle` clears the
  restriction.
- `In Gruppen mischen` changes order inside each displayed group and never
  moves a word between group boundaries.
- `Gesamtliste mischen` changes the whole list and rebuilds balanced groups.
- `Reihenfolge` restores numeric vocabulary order.
- Existing notes, targets, status marks, scheduled tracks, and imported IDs
  survive all presentation changes.
- Missing CSV IDs retain stored history but never render or enter a session.
  New CSV IDs remain unintroduced until explicitly marked.

## 5. Keyboard and popup contract

On the board:

- `I` / ArrowUp: previous word in the current group.
- `K` / ArrowDown: next word in the current group.
- `J` / ArrowLeft: previous non-empty group.
- `L` / ArrowRight: next non-empty group, including group 7 → 8.
- `G`: mark selected row green/known.
- `R`: mark selected row red/forgotten.
- `W`: clear the selected row's green/red mark.
- `T`: toggle the selected word's target flag.
- `D`: open the selected word's detail popup.

Navigation preserves selection, scrolls the focused row into view, and never
opens the popup. Rows stay in place after marking.

The D popup must:

- be a native centered dialog, max-width 720px and max-height 85dvh;
- blur/dim the board behind it;
- show meaning first, then optional example/translation/grammar/mnemonic;
- never render an image or empty image placeholder;
- consume every keydown while open, close on that key, and restore selection;
- keep the dismissal key consumed until keyup so held G/R/W cannot leak through;
- restore focus and announce that the definition closed;
- offer pronunciation and close buttons without grading.

Notes use a separate dialog. Input, textarea, select, composition, and
modifier-key events must not trigger board shortcuts.

## 6. Practice, test, and production direction

- G/R/W on the board are visible practice marks and remain reversible with W.
- Group tests and Sprint are labeled practice and do not alter scheduled
  intervals or create review events.
- DE → EN remains the library presentation. EN → DE must show only the English
  prompt before D; German, article, speech, examples, and notes stay hidden.
- If a production prompt is ambiguous, exclude it without recording a wrong
  answer. The D popup provides `EN → DE wieder aktivieren` for restoration.
- Keep DE → EN and EN → DE schedule tracks independent in persisted data even
  though the current board does not require a daily review queue.

## 7. Persistence and recovery

- Keep vocabulary, notes, targets, presentation order, and review history in
  browser-local storage.
- Validate JSON imports before replacing working state; show a count preview
  and require confirmation. Preserve the previous valid state as backup.
- Invalid v3 data must show export, backup-restore, and new-start choices; do
  not silently overwrite it.
- A storage quota failure keeps the pending result in memory and offers retry
  or export.
- A stale-tab revision mismatch blocks further writes until reload; it must
  not permit a later mutation to overwrite the newer tab.
- `Lernplan zurücksetzen` clears schedules while preserving notes, targets,
  and ordering.
- `Alle App-Daten löschen` requires confirmation and removes active state,
  migration backups, and recovery snapshots. It must not resurrect old v2 data
  on the next load.
- Browser storage is origin-specific. Use `http://127.0.0.1:8000` consistently;
  moving host, port, or browser requires JSON export/import.

## 8. Verification checklist

Run these commands after changes:

```bash
node --check public/assets/js/app.js
node --check public/assets/js/srs.js
node --check public/assets/js/study-app.js
node tests/app.test.js
node tests/srs.test.js
```

Confirm manually in a browser at 1600px, 1100px, 800px, and 390px:

1. Only `Alle Gruppen` is visible in primary navigation.
2. Level combinations rebuild groups and preserve row data.
3. Range edits, both shuffle controls, reset order, and target filtering work.
4. Seven groups fit the first wide row; group eight starts below it.
5. I/J/K/L and arrows move correctly and skip empty groups.
6. G/R/W mark rows; D opens the popup; any key closes without grading.
7. EN → DE does not leak German before D.
8. Notes accept G/R/W/D as ordinary text in their own dialog.
9. Group tests and Sprint identify themselves as practice and leave schedules
   unchanged.
10. Export/import, invalid-data recovery, stale-tab blocking, and both reset
    scopes behave as described.
11. The CSV contains only A1, A2, and B1 Nicos Weg rows, B2 has zero rows, and
    a repeated importer run produces byte-identical CSV and translation cache.

Do not claim completion from pure helper tests alone when browser interaction
testing is unavailable; report that limitation explicitly.
