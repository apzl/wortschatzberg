# Wortschatzberg

Wortschatzberg is a local, browser-based German vocabulary trainer. It combines
one new vocabulary group per day with selectable spaced reviews from earlier
groups. It stores learning schedules, progress, targets, and notes in the
browser.

The project uses plain HTML, CSS, and JavaScript. There is no build step,
package installation, backend service, or account system.

## Requirements

- A current web browser
- Python 3 to run the local web server
- Node.js 18 or newer only if you want to run the automated tests

## Setup

Clone or download the project, then enter its directory:

```bash
cd /home/apsal/workspace/Wortschatzberg
```

Start a local server:

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory public
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

Keep the terminal running while using the app. Stop the server with `Ctrl+C`.
If port 8000 is already occupied, choose another port, for example:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory public
```

Then open [http://localhost:8080](http://localhost:8080).

Do not open `public/index.html` directly with a `file://` URL. Browsers block
the CSV request in that mode, so the vocabulary will not load.

### Vercel deployment

The app can be deployed directly as a static Vercel project. It has no build
step and does not need environment variables.

Authenticate once and deploy from the repository root:

```bash
npx vercel@latest login
npx vercel@latest --prod
```

On the first deployment, select your Vercel account or team and accept the
suggested project settings. Vercel creates `.vercel/project.json` locally to
link later deployments to the same project. Do not commit the `.vercel`
directory.

After the first deployment, publish later versions with:

```bash
npx vercel@latest --prod
```

No Vercel environment variables are required. Learning progress is stored in
each browser's local storage, so a new Vercel URL starts with separate browser
data. Export from the local site and import on the deployed site if you want to
carry existing progress across.

### Docker deployment

Docker Compose serves the same app at the same host port:

If Docker is not installed on Ubuntu/WSL, run the repository installer once:

```bash
./install-docker-and-run.sh
```

It requests sudo, installs Docker Engine and the Compose plugin from Docker's
official Ubuntu repository, starts the daemon, builds this project, and leaves
the container running on port 8000.

If Docker is already installed, run:

```bash
docker compose up -d --build
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The container listens on
port 80 internally and Compose binds it to `127.0.0.1:8000` on the host. Check
the service with:

```bash
docker compose ps
docker compose logs -f wortschatzberg
```

Stop it with:

```bash
docker compose down
```

Browser progress remains in the browser's local storage; rebuilding the static
container does not migrate or erase that data. Use the app's JSON export/import
when moving between browser origins or machines.

## Alle Gruppen

`Alle Gruppen` is the only primary view. It keeps the full vocabulary board
visible while you choose the level combination, inclusive group range, order,
and selected word. The board is intentionally direct: there is no separate
daily-plan tab or automatic catch-up queue.

- The board presents German → English words by default. Use the `DE → EN`
  direction button to reverse the list to `EN → DE`; reversed mode shows only
  English meanings, and `d` reveals the German word in the pop-up. The selected
  direction is stored in the browser.
- If an English prompt has several plausible German answers, exclude it from
  EN → DE without recording a failure. Re-enable it later from its `d` popup.
- `G` marks successful recall, `R` marks a forgotten word, and `W` clears the
  board mark. Scheduled-history and migration data remain browser-local.
- Spaced-review history remains exportable and uses independent direction
  tracks; the board itself does not force a review queue.
- Select an inclusive starting and ending group with `Gruppe von` and `bis`.
- `Bis Gruppe` shows every group from the selected start through that group.
  Seven groups appear per desktop row; additional groups continue below.
- Use the level checkboxes to show any combination of A1, A2, B1, and B2.
  Choosing `Alle` clears the level restriction.
- Changing levels rebuilds the groups from only the selected vocabulary. One
  level produces fewer groups; adding levels increases the group count.
- Groups are balanced at 30 words or more. When multiple levels are selected,
  every group contains words from each selected level.
- `In Gruppen mischen` changes word order without moving words across group
  boundaries.
- `Gesamtliste mischen` shuffles every word and creates new groups of 30.
- Select a word and press `d` to open its definition pop-up. The group list
  remains visible and blurred behind it.
- Group tests and the 60-second sprint remain free practice and do not advance
  the spaced-review schedule.
- Use `Einstellungen` to change the learning direction policy, export/import a
  JSON backup, or reset the schedule while preserving notes and targets.

### Keyboard shortcuts

On the group screen:

| Key | Action |
|---|---|
| `g` | Mark the selected word green (known) |
| `r` | Mark the selected word red (forgotten) |
| `w` | Clear the selected word's red/green state |
| `d` | Reveal the selected word's answer in a pop-up |
| `t` | Add/remove the selected word from the target list |
| `i` / `ArrowUp` | Move to the previous word |
| `j` / `ArrowLeft` | Move to the group on the left |
| `k` / `ArrowDown` | Move to the next word |
| `l` / `ArrowRight` | Move to the group on the right |

While the definition pop-up is open:

| Key | Action |
|---|---|
| Any key | Close the pop-up and return to the group list |

The popup reveals the answer and closes on any key. Grading controls remain on
the board footer. Personal notes are edited in a separate typing-safe dialog.

## Run the tests

No dependencies need to be installed:

```bash
node --check public/assets/js/app.js
node --check public/assets/js/srs.js
node --check public/assets/js/study-app.js
node tests/app.test.js
node tests/srs.test.js
```

The tests cover grouping and navigation plus calendar scheduling, retry limits,
direction isolation, undo, staged activation, storage migration, and stale-tab
protection.

## Vocabulary data

The bundled vocabulary is generated from Deutsche Welle's official
[Nicos Weg](https://learngerman.dw.com/en/nicos-weg/c-36519789) lesson
materials. Nicos Weg currently provides A1, A2, and B1 content, so the B2
filter remains available in the UI but intentionally has no words yet.

- A1 and A2 English meanings come from DW's English lesson PDFs.
- B1 lesson PDFs provide German definitions rather than English glosses. The
  importer reuses matching English meanings already in the local dataset, then
  uses its checked-in translation cache for the remaining entries.
- Source lesson, unit, and level are retained in each row's `notes` field.
- No lesson PDFs or images are shipped with the app.

The app expects `public/data/vocab.csv` with this header:

```text
id,group,german,article,notes,pos,english,mnemonic,level,example,image
```

The UI first selects the requested CEFR levels, then derives balanced groups of
at least 30 words. Multiple selected levels are distributed across every group.
The CSV's `group` column is retained as source metadata and does not control the
displayed groups.

Required fields are `id`, `german`, and `english`. Optional mnemonic, example,
grammar, article, and level values are omitted cleanly when unavailable. The
legacy `image` column is accepted as source data but is not rendered.

To rebuild the dataset, install `pdftotext` (provided by `poppler-utils`) and
run from the repository root:

```bash
python3 scripts/import_nicos_weg.py --translate-missing
```

The importer downloads uncached PDFs listed in
`scripts/data/nicos-weg-pdfs.txt`, validates all 228 lessons, deduplicates the
vocabulary in course order, assigns stable IDs and 30-word source groups, and
writes the CSV atomically. `--translate-missing` contacts a public translation
service only for unmatched B1 headwords and stores the results in
`scripts/data/nicos-weg-b1-english.json`; subsequent builds use that cache.
The `nw-` ID namespace prevents progress from the replaced vocabulary dataset
from being attached to unrelated Nicos Weg words.

## Project structure

```text
public/
├── index.html                 Page shell
├── assets/
│   ├── css/style.css          Responsive application styles
│   └── js/
│       ├── app.js             CSV, grouping, and practice helpers
│       ├── srs.js             Spaced-review and persistence core
│       └── study-app.js       Group board, popup, settings, and tests UI
└── data/vocab.csv             German vocabulary dataset
tests/                         Dependency-free Node test suites
scripts/
├── import_nicos_weg.py        Reproducible DW vocabulary importer
└── data/                      DW PDF manifest and B1 translation cache
docs/PLAN.md                   Product scope and acceptance plan
Dockerfile                     Nginx container image
docker-compose.yml             Local container configuration
nginx.conf                     Static-site server configuration
install-docker-and-run.sh      Ubuntu/WSL Docker installer and launcher
vercel.json                    Vercel static-output configuration
```

## Resetting local data

Use `Lernplan zurücksetzen` in Einstellungen to clear batches, due dates, and
review history while preserving notes, targets, and library ordering. `Alle
App-Daten löschen` also removes those preserved items and the app's local
backups after a second confirmation. Export a JSON backup first if you may want
to restore anything. These actions only change browser-local data and never
modify `public/data/vocab.csv`.

Browser storage belongs to an exact origin. Continue using
`http://127.0.0.1:8000`; `localhost`, a different port, or a different browser
has separate storage. Use JSON export/import when moving between origins.
