/* Wortschatzberg study workspace. Dependency-free and browser-local. */
(function (root) {
  "use strict";
  const GROUP_SIZE = 30, STORAGE_KEY = "wortschatzberg:v2", LEGACY_KEY = "wb_known", STATE_VERSION = 2;

  function parseCSV(text) {
    const rows = []; let field = "", row = [], quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
        else if (char === '"') quoted = false; else field += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { row.push(field); field = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i += 1;
        row.push(field); field = ""; if (row.length > 1 || row[0]) rows.push(row); row = [];
      } else field += char;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows.shift().map(value => value.trim());
    return rows.map(values => Object.fromEntries(header.map((key, i) => [key, values[i] || ""])));
  }
  function normalizeWords(rows) {
    return rows.filter(r => String(r.id || "").trim() && String(r.german || "").trim()).map(r => ({
      id: String(r.id).trim(), sourceGroup: String(r.group || "").trim(), german: String(r.german || "").trim(),
      article: String(r.article || "").trim(), notes: String(r.notes || "").trim(), pos: String(r.pos || "").trim(),
      english: String(r.english || "").trim(), mnemonic: String(r.mnemonic || "").trim(), level: String(r.level || "").trim(),
      example: String(r.example || "").trim(), image: String(r.image || "").trim(),
    }));
  }
  function numericIdSort(a, b) {
    const an = Number(a), bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return String(a).localeCompare(String(b), "de", { numeric: true });
  }
  function partition(order, size = GROUP_SIZE) { const out = []; for (let i = 0; i < order.length; i += size) out.push(order.slice(i, i + size)); return out; }
  function reconcileOrder(saved, ids) {
    const valid = new Set(ids.map(String)), seen = new Set(), kept = [];
    if (Array.isArray(saved)) saved.forEach(raw => { const id = String(raw); if (valid.has(id) && !seen.has(id)) { kept.push(id); seen.add(id); } });
    ids.map(String).filter(id => !seen.has(id)).sort(numericIdSort).forEach(id => kept.push(id)); return kept;
  }
  function fisherYates(values, rng = Math.random) {
    const out = values.slice(); for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out;
  }
  function shuffleWithinRange(order, start, end, size = GROUP_SIZE, rng = Math.random) {
    return partition(order, size).flatMap((group, i) => i + 1 >= start && i + 1 <= end ? fisherYates(group, rng) : group);
  }
  function clampNumber(value, min, max) { const n = Number.parseInt(value, 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)); }
  function clampRange(start, end, max, changed = "start") {
    let s = clampNumber(start, 1, max), e = clampNumber(end, 1, max);
    if (s > e) { if (changed === "end") s = e; else e = s; } return { start: s, end: e };
  }
  function dayWindow(day, start, end) {
    const active = clampNumber(day, start, end);
    return Array.from({ length: active - start + 1 }, (_, i) => start + i);
  }
  function cleanLevels(value, legacyLevel = "", validLevels = []) {
    const candidates = Array.isArray(value) ? value : legacyLevel ? [legacyLevel] : [], valid = new Set(validLevels), seen = new Set();
    return candidates.map(String).filter(level => level && (!valid.size || valid.has(level)) && !seen.has(level) && seen.add(level));
  }
  function cleanListDirection(value) { return value === "enDe" ? "enDe" : "deEn"; }
  function libraryPromptText(word, direction = "deEn") {
    if (!word) return "";
    if (cleanListDirection(direction) === "enDe") return String(word.english || "").trim();
    return [word.article, word.german].map(value => String(value || "").trim()).filter(Boolean).join(" ");
  }
  function balancedPartition(order, minimum = GROUP_SIZE) {
    if (!order.length) return [];
    const count = Math.max(1, Math.floor(order.length / minimum)), base = Math.floor(order.length / count), extra = order.length % count, groups = [];
    let offset = 0; for (let i = 0; i < count; i += 1) { const length = base + (i < extra ? 1 : 0); groups.push(order.slice(offset, offset + length)); offset += length; }
    return groups;
  }
  function buildLevelGroups(order, wordMap, selectedLevels = [], minimum = GROUP_SIZE) {
    const available = [...new Set(order.map(id => wordMap.get(String(id))?.level).filter(Boolean))].sort(), levels = selectedLevels.length ? selectedLevels.filter(level => available.includes(level)) : available;
    const buckets = levels.map(level => order.map(String).filter(id => wordMap.get(id)?.level === level)), total = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
    if (!total) return []; if (buckets.length <= 1) return balancedPartition(buckets[0] || [], minimum);
    const count = Math.max(1, Math.floor(total / minimum)), groups = Array.from({ length: count }, () => []); let cursor = 0;
    buckets.forEach(bucket => bucket.forEach(id => { groups[cursor % count].push(id); cursor += 1; })); return groups;
  }
  function shuffleGroupRange(groups, start, end, rng = Math.random) {
    return groups.map((group, index) => index + 1 >= start && index + 1 <= end ? fisherYates(group, rng) : group.slice());
  }
  function defaultState(ids) {
    return { version: STATE_VERSION, activeDay: 1, groupStart: 1, groupEnd: Math.max(1, Math.floor(ids.length / GROUP_SIZE)), levels: [], level: "",
      includeLearned: true, definitionOnNavigate: true, centerDefinition: true, colorPreviousDays: true, palette: "blue", targetMode: false, listDirection: "deEn",
      order: ids.slice().sort(numericIdSort), presentation: null, words: {}, lastTest: null };
  }
  function cleanWordRecord(value) {
    const v = value && typeof value === "object" ? value : {};
    return { target: v.target === true, learned: v.learned === true, lastResult: ["correct", "wrong"].includes(v.lastResult) ? v.lastResult : null, note: typeof v.note === "string" ? v.note : "" };
  }
  function cleanLastTest(value, ids) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const correct = Number(value.correct), total = Number(value.total);
    if (!Number.isInteger(correct) || !Number.isInteger(total) || correct < 0 || total < 0 || correct > total) return null;
    const valid = new Set(ids.map(String)), missed = Array.isArray(value.missed) ? value.missed.map(String).filter(id => valid.has(id)) : [];
    const group = value.group == null ? null : Number(value.group);
    return { correct, total, missed, group: Number.isInteger(group) && group >= 1 ? group : null,
      sprint: value.sprint === true, date: typeof value.date === "string" ? value.date : "" };
  }
  function hydrateState(raw, ids, legacy = [], validLevels = []) {
    const defaults = defaultState(ids), source = raw && typeof raw === "object" && raw.version === STATE_VERSION ? raw : {};
    const range = clampRange(source.groupStart ?? 1, source.groupEnd ?? defaults.groupEnd, defaults.groupEnd, "start"), records = {}, levels = cleanLevels(source.levels, typeof source.level === "string" ? source.level : "", validLevels);
    if (source.words && typeof source.words === "object") ids.forEach(id => { if (source.words[id]) records[id] = cleanWordRecord(source.words[id]); });
    if (!raw || raw.version !== STATE_VERSION) (Array.isArray(legacy) ? legacy : []).map(String).filter(id => ids.includes(id)).forEach(id => { records[id] = { ...cleanWordRecord(records[id]), learned: true }; });
    return { ...defaults, activeDay: clampNumber(source.activeDay ?? range.start, range.start, range.end), groupStart: range.start, groupEnd: range.end,
      levels, level: levels.length === 1 ? levels[0] : "", includeLearned: source.includeLearned !== false,
      definitionOnNavigate: source.definitionOnNavigate !== false, centerDefinition: source.centerDefinition !== false,
      colorPreviousDays: source.colorPreviousDays !== false, palette: ["blue", "purple", "teal"].includes(source.palette) ? source.palette : "blue",
      targetMode: source.targetMode === true, listDirection: cleanListDirection(source.listDirection), order: reconcileOrder(source.order, ids), presentation: source.presentation && typeof source.presentation === "object" && typeof source.presentation.key === "string" && Array.isArray(source.presentation.order) ? { key: source.presentation.key, order: source.presentation.order.map(String) } : null, words: records,
      lastTest: cleanLastTest(source.lastTest, ids) };
  }
  function filterWordIds(order, groups, wordMap, records, prefs) {
    const selectedLevels = Array.isArray(prefs.levels) ? prefs.levels : prefs.level ? [prefs.level] : [], built = buildLevelGroups(order, wordMap, selectedLevels), ids = groups.flatMap(group => built[group - 1] || []);
    return ids.filter(id => { const rec = cleanWordRecord(records[id]); return (prefs.includeLearned || !rec.learned) && (!prefs.targetMode || rec.target); });
  }
  function resetDayRecords(records, ids) {
    const out = { ...records }; ids.forEach(id => { const rec = cleanWordRecord(out[id]); out[id] = { ...rec, learned: false, lastResult: null }; }); return out;
  }
  function createQuestion(id, pool, map, rng = Math.random) {
    const correct = map.get(id); if (!correct) return null; const alternatives = [], seen = new Set([correct.english]);
    fisherYates(pool, rng).forEach(other => { const w = map.get(other); if (w?.english && !seen.has(w.english)) { alternatives.push(w.english); seen.add(w.english); } });
    return { id, options: alternatives.length < 3 ? null : fisherYates([correct.english, ...alternatives.slice(0, 3)], rng) };
  }
  function cycleSprintQueue(test, now = Date.now(), rng = Math.random) {
    if (!test?.sprint || test.index < test.queue.length || now >= test.deadline || !test.pool.length) return false;
    test.queue = fisherYates(test.pool, rng); test.index = 0; test.answered = false; test.chosen = null; test.question = null; return true;
  }
  function dashboardMoveForKey(value) {
    return ({ i: [-1, 0], j: [0, -1], k: [1, 0], l: [0, 1], arrowup: [-1, 0], arrowleft: [0, -1], arrowdown: [1, 0], arrowright: [0, 1] })[String(value).toLowerCase()] || null;
  }
  function dashboardResultForKey(value) {
    const results = { g: "correct", r: "wrong", w: null }, key = String(value).toLowerCase();
    return Object.prototype.hasOwnProperty.call(results, key) ? results[key] : undefined;
  }
  function shouldDismissDetail(event) { return Boolean(event && typeof event.key === "string"); }
  const exported = { GROUP_SIZE, parseCSV, normalizeWords, numericIdSort, partition, reconcileOrder, fisherYates, shuffleWithinRange, clampRange, dayWindow, cleanLevels, cleanListDirection, libraryPromptText, balancedPartition, buildLevelGroups, shuffleGroupRange, defaultState, cleanWordRecord, cleanLastTest, hydrateState, filterWordIds, resetDayRecords, createQuestion, cycleSprintQueue, dashboardMoveForKey, dashboardResultForKey, shouldDismissDetail };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) root.WortschatzCore = exported;
  if (!root?.document || root.WORTSCHATZ_CORE_ONLY) return;

  const document = root.document, app = document.getElementById("app"); if (!app) return;
  let words = [], wordMap = new Map(), prefs = null;
  const transient = { view: "dashboard", selectedId: null, selectedGroup: null, detailIds: [], returnScroll: 0, test: null, sprintInterval: null };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const cssEsc = value => root.CSS?.escape ? root.CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  function loadJSON(key, fallback) { try { return JSON.parse(root.localStorage.getItem(key) || "null") ?? fallback; } catch (_) { return fallback; } }
  function save() { try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (_) { announce("Speichern ist nicht verfügbar."); } }
  function recordFor(id) { if (!prefs.words[id]) prefs.words[id] = cleanWordRecord(); return prefs.words[id]; }
  const presentationKey = () => prefs.levels.length ? [...prefs.levels].sort().join("+") : "*";
  function ensurePresentationOrder() {
    const generated = buildLevelGroups(prefs.order, wordMap, prefs.levels).flat(), key = presentationKey();
    if (prefs.presentation?.key === key) prefs.presentation.order = reconcileOrder(prefs.presentation.order, generated);
    else prefs.presentation = { key, order: generated };
    return prefs.presentation.order;
  }
  const presentationGroups = () => balancedPartition(ensurePresentationOrder());
  const groupCount = () => Math.max(1, presentationGroups().length);
  const idsForGroup = group => presentationGroups()[group - 1] || [];
  const rangeGroups = () => Array.from({ length: prefs.groupEnd - prefs.groupStart + 1 }, (_, i) => prefs.groupStart + i);
  const visibleIds = groups => { const built = presentationGroups(); return groups.flatMap(group => built[group - 1] || []).filter(id => { const rec = cleanWordRecord(prefs.words[id]); return (prefs.includeLearned || !rec.learned) && (!prefs.targetMode || rec.target); }); };
  const detailPool = () => visibleIds(rangeGroups());
  function syncGroupRange(reset = false) {
    const max = groupCount(); if (reset) { prefs.groupStart = 1; prefs.groupEnd = max; prefs.activeDay = 1; }
    else { const range = clampRange(prefs.groupStart, prefs.groupEnd, max, "end"); prefs.groupStart = range.start; prefs.groupEnd = range.end; prefs.activeDay = clampNumber(prefs.activeDay, range.start, range.end); }
  }
  function groupForId(id) { const index = presentationGroups().findIndex(group => group.includes(id)); return index >= 0 ? index + 1 : null; }
  const displayWord = w => `${w.article ? `${esc(w.article)} ` : ""}${esc(w.german)}`;
  function announce(text) { const live = document.getElementById("liveRegion"); if (live) { live.textContent = ""; root.setTimeout(() => { live.textContent = text; }, 10); } }
  const options = (values, selected) => values.map(v => `<option value="${esc(v)}"${String(v) === String(selected) ? " selected" : ""}>${esc(v)}</option>`).join("");

  function pagerHTML() {
    const days = rangeGroups(); return `<nav class="day-pager" aria-label="Tagesnavigation">
      <button type="button" data-day-action="prev" aria-label="Vorheriger Tag"${prefs.activeDay <= prefs.groupStart ? " disabled" : ""}>‹</button>
      <label>Tag <select class="day-select" aria-label="Tag auswählen">${options(days, prefs.activeDay)}</select></label>
      <button type="button" data-day-action="next" aria-label="Nächster Tag"${prefs.activeDay >= prefs.groupEnd ? " disabled" : ""}>›</button>
      <button type="button" data-day-action="plus3" aria-label="Drei Tage weiter"${prefs.activeDay >= prefs.groupEnd ? " disabled" : ""}>+3</button></nav>`;
  }
  function toolbarHTML() {
    const levels = [...new Set(words.map(w => w.level).filter(Boolean))].sort(), groups = Array.from({ length: groupCount() }, (_, i) => i + 1);
    const levelChecks = levels.map(level => `<label><input type="checkbox" data-level-filter="${esc(level)}"${prefs.levels.includes(level) ? " checked" : ""}> ${esc(level)}</label>`).join("");
    const levelLabel = prefs.levels.length ? prefs.levels.join(" + ") : "Alle Stufen", visibleCount = visibleIds(rangeGroups()).length;
    return `<section id="toolbar" class="utility-toolbar" aria-label="Lernwerkzeuge"><div class="toolbar-panel toolbar-main">
      <div class="tool-actions">
        <button class="tool-button" type="button" data-action="navigation"><span aria-hidden="true">⌂</span><span>Navigation</span></button>
        <div class="tool-button tool-hint" aria-label="Mit D Definition öffnen"><span aria-hidden="true">D</span><span>Definition</span></div>
        <button class="tool-button" id="helpButton" type="button"><span aria-hidden="true">?</span><span>So funktioniert's</span></button>
        <button class="tool-button${prefs.targetMode ? " is-active" : ""}" id="targetMode" type="button" aria-pressed="${prefs.targetMode}"><span aria-hidden="true">★</span><span>Zielliste</span></button>
        <button class="tool-button" id="resetOrder" type="button"><span aria-hidden="true">↺</span><span>Reihenfolge</span></button>
        <button class="tool-button" id="sprintButton" type="button"><span aria-hidden="true">⚑</span><span>Sprint</span></button>
      </div><div id="filters" class="filter-row">
        <fieldset class="level-filter"><legend>Stufen</legend><label><input id="allLevels" type="checkbox"${prefs.levels.length ? "" : " checked"}> Alle</label>${levelChecks}</fieldset>
        <label>Gruppe von <select id="groupStart">${options(groups, prefs.groupStart)}</select></label>
        <label>bis <select id="groupEnd">${options(groups, prefs.groupEnd)}</select></label>
        <label class="check-label"><input id="includeLearned" type="checkbox"${prefs.includeLearned ? " checked" : ""}> Gelernte</label>
        <button id="shuffleGroups" type="button">⇄ In Gruppen mischen</button><button id="shuffleAll" type="button">⤨ Gesamtliste mischen</button>
        <span class="range-summary">${esc(levelLabel)} · Gruppen ${prefs.groupStart}–${prefs.groupEnd} · ${visibleCount.toLocaleString("de-DE")} Wörter</span>
      </div></div><div class="toolbar-panel toolbar-settings">
        <span class="detail-mode-note"><kbd>D</kbd> öffnet das ausgewählte Wort</span><button id="resetAll" type="button" class="danger-soft">Alles zurücksetzen</button>
        <label><input id="centerDefinition" type="checkbox"${prefs.centerDefinition ? " checked" : ""}> Definition zentrieren</label><button id="resetDay" type="button">Tag zurücksetzen</button>
        <label><input id="colorPreviousDays" type="checkbox"${prefs.colorPreviousDays ? " checked" : ""}> Vorherige Tage farbig markieren</label><button id="paletteButton" type="button">Farben</button>
      </div></section>`;
  }
  function noticesHTML() {
    const review = Object.values(prefs.words).some(r => r.target || r.lastResult === "wrong"), last = prefs.lastTest;
    return `<section id="noticeStack" aria-label="Hinweise">${review ? `<div class="notice notice-yellow">Du hast Zielwörter oder Fehler zum Wiederholen. Öffne die Zielliste oder starte einen Gruppentest.</div>` : ""}${last ? `<div class="notice notice-blue">Letzter Test: ${last.correct} von ${last.total} richtig.${last.missed?.length ? ` <button type="button" id="retryMissed">Fehler wiederholen</button>` : ""}</div>` : ""}<div class="notice notice-orange"><strong>Nur auf diesem Gerät:</strong> Fortschritt und Notizen werden ausschließlich in diesem Browser gespeichert.</div></section>`;
  }
  function rowHTML(id, group) {
    const w = wordMap.get(id), r = recordFor(id), classes = ["word-row"];
    if (id === transient.selectedId) classes.push("is-selected"); if (r.target) classes.push("is-target"); if (r.learned) classes.push("is-learned");
    if (r.lastResult) classes.push(`is-${r.lastResult}`); if (group < prefs.activeDay && prefs.colorPreviousDays) classes.push("is-previous");
    const previous = group < prefs.activeDay && prefs.colorPreviousDays;
    const states = [r.target && "Zielwort", r.learned && "gelernt", r.lastResult === "correct" && "richtig", r.lastResult === "wrong" && "falsch", previous && "vorheriger Tag"].filter(Boolean).join(", ");
    const markers = `${previous ? `<span class="status-marker status-previous" title="Vorheriger Tag">↶</span>` : ""}${r.lastResult === "correct" ? `<span class="status-marker status-correct" title="Richtig">✓</span>` : ""}${r.lastResult === "wrong" ? `<span class="status-marker status-wrong" title="Falsch">!</span>` : ""}`;
    return `<tr class="${classes.join(" ")}" data-id="${esc(id)}" data-group="${group}" tabindex="${id === transient.selectedId ? "0" : "-1"}" aria-selected="${id === transient.selectedId}"><td class="word-cell"><button type="button" class="word-select" data-select-id="${esc(id)}">${r.target ? `<span class="target-marker" aria-hidden="true">★</span>` : ""}${r.learned ? `<span class="learned-marker" aria-hidden="true">✓</span>` : ""}${displayWord(w)}</button></td><td class="state-cell"><span class="sr-only">${esc(states)}</span><span class="status-markers" aria-hidden="true">${markers}</span><button type="button" class="target-toggle" data-target-id="${esc(id)}" aria-label="${r.target ? "Aus Zielliste entfernen" : "Zur Zielliste hinzufügen"}" aria-pressed="${r.target}">${r.target ? "★" : "☆"}</button></td></tr>`;
  }
  function groupColumnHTML(group) {
    const ids = visibleIds([group]); return `<section class="group-column" data-group="${group}" aria-labelledby="group-title-${group}"><h2 class="group-heading" id="group-title-${group}">Gruppe ${group}</h2><button class="group-test" type="button" data-test-group="${group}"${ids.length ? "" : " disabled"}>Test ${group}</button>${ids.length ? `<table class="word-table"><caption class="sr-only">Vokabeln der Gruppe ${group}</caption><tbody>${ids.map(id => rowHTML(id, group)).join("")}</tbody></table>` : `<p class="group-empty">${prefs.targetMode ? "Keine Zielwörter. Zielliste ausschalten, ein Wort wählen und T drücken." : "Keine Wörter entsprechen den Filtern."}</p>`}</section>`;
  }
  function selectDefault() {
    const current = visibleIds(dayWindow(prefs.activeDay, prefs.groupStart, prefs.groupEnd));
    if (!current.includes(transient.selectedId)) transient.selectedId = current[0] || null;
    if (transient.selectedId) transient.selectedGroup = groupForId(transient.selectedId);
  }
  function renderDashboard(focus = false) {
    stopSprint(); transient.view = "dashboard"; selectDefault(); const shown = dayWindow(prefs.activeDay, prefs.groupStart, prefs.groupEnd);
    app.innerHTML = `<div id="dashboardView" data-palette="${prefs.palette}">${toolbarHTML()}<p class="help-line">Nicht sicher, wie das funktioniert? <button id="helpLink" type="button">Anleitung öffnen</button></p>${noticesHTML()}${pagerHTML()}<div id="groupColumns" class="group-columns">${shown.map(groupColumnHTML).join("")}</div>${pagerHTML()}<div id="liveRegion" class="sr-only" aria-live="polite"></div></div>`;
    wireDashboard(); if (focus && transient.selectedId) document.querySelector(`[data-id="${cssEsc(transient.selectedId)}"]`)?.focus();
  }
  function moveDay(delta) { prefs.activeDay = clampNumber(prefs.activeDay + delta, prefs.groupStart, prefs.groupEnd); transient.selectedId = null; save(); renderDashboard(); }
  function setRange(changed, value) {
    const r = clampRange(changed === "start" ? value : prefs.groupStart, changed === "end" ? value : prefs.groupEnd, groupCount(), changed);
    prefs.groupStart = r.start; prefs.groupEnd = r.end; prefs.activeDay = clampNumber(prefs.activeDay, r.start, r.end); transient.selectedId = null; save(); renderDashboard();
  }
  function setLevel(level, checked) {
    const selected = new Set(prefs.levels); if (checked) selected.add(level); else selected.delete(level);
    prefs.levels = [...selected]; prefs.level = prefs.levels.length === 1 ? prefs.levels[0] : ""; prefs.presentation = null; syncGroupRange(true); transient.selectedId = null; save(); renderDashboard();
  }
  function selectWord(id) { transient.selectedId = id; transient.selectedGroup = groupForId(id); renderDashboard(true); }
  function moveDashboard(vertical, horizontal) {
    const groups = dayWindow(prefs.activeDay, prefs.groupStart, prefs.groupEnd); let gi = Math.max(0, groups.indexOf(transient.selectedGroup));
    let ids = visibleIds([groups[gi]]), ri = Math.max(0, ids.indexOf(transient.selectedId));
    if (horizontal) { gi = clampNumber(gi + horizontal, 0, groups.length - 1); ids = visibleIds([groups[gi]]); if (!ids.length) return; ri = Math.min(ri, ids.length - 1); }
    else ri = clampNumber(ri + vertical, 0, Math.max(0, ids.length - 1)); if (ids[ri]) selectWord(ids[ri]);
  }
  function toggleTarget(id) { const r = recordFor(id); r.target = !r.target; save(); if (prefs.targetMode && !r.target) transient.selectedId = null; renderDashboard(true); }
  function selectFirstInActiveGroup() { transient.selectedId = visibleIds([prefs.activeDay])[0] || null; }
  function orderFeedback(buttonId, label, message) {
    const button = document.getElementById(buttonId); if (button) { const original = button.textContent; button.textContent = label; root.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1400); }
    announce(message);
  }
  function wireDashboard() {
    app.querySelectorAll(".day-select").forEach(s => s.onchange = e => { prefs.activeDay = clampNumber(e.target.value, prefs.groupStart, prefs.groupEnd); transient.selectedId = null; save(); renderDashboard(); });
    app.querySelectorAll("[data-day-action]").forEach(b => b.onclick = () => moveDay(b.dataset.dayAction === "prev" ? -1 : b.dataset.dayAction === "next" ? 1 : 3));
    app.querySelectorAll("[data-select-id]").forEach(b => b.onclick = () => selectWord(b.dataset.selectId));
    app.querySelectorAll("[data-target-id]").forEach(b => b.onclick = e => { e.stopPropagation(); toggleTarget(b.dataset.targetId); });
    app.querySelectorAll("[data-test-group]").forEach(b => b.onclick = () => startTest(visibleIds([Number(b.dataset.testGroup)]), false, Number(b.dataset.testGroup)));
    document.getElementById("groupStart").onchange = e => setRange("start", e.target.value); document.getElementById("groupEnd").onchange = e => setRange("end", e.target.value);
    document.getElementById("allLevels").onchange = () => { prefs.levels = []; prefs.level = ""; prefs.presentation = null; syncGroupRange(true); transient.selectedId = null; save(); renderDashboard(); };
    app.querySelectorAll("[data-level-filter]").forEach(input => input.onchange = e => setLevel(e.target.dataset.levelFilter, e.target.checked));
    document.getElementById("includeLearned").onchange = e => { prefs.includeLearned = e.target.checked; transient.selectedId = null; save(); renderDashboard(); };
    ["centerDefinition", "colorPreviousDays"].forEach(id => document.getElementById(id).onchange = e => { prefs[id] = e.target.checked; save(); renderDashboard(); });
    document.getElementById("targetMode").onclick = () => { prefs.targetMode = !prefs.targetMode; transient.selectedId = null; save(); renderDashboard(); };
    document.getElementById("shuffleGroups").onclick = () => { prefs.presentation = { key: presentationKey(), order: shuffleGroupRange(presentationGroups(), prefs.groupStart, prefs.groupEnd).flat() }; selectFirstInActiveGroup(); save(); renderDashboard(); orderFeedback("shuffleGroups", "Gemischt ✓", "Ausgewählte Gruppen wurden gemischt."); };
    document.getElementById("shuffleAll").onclick = () => confirmDialog("Die Gesamtliste wird gemischt und alle Gruppen werden neu zusammengesetzt.", () => { prefs.order = fisherYates(prefs.order); prefs.presentation = null; selectFirstInActiveGroup(); save(); renderDashboard(); orderFeedback("shuffleAll", "Gemischt ✓", "Die Gesamtliste wurde gemischt."); });
    document.getElementById("resetOrder").onclick = () => confirmDialog("Die ursprüngliche Reihenfolge und Gruppeneinteilung wiederherstellen?", () => { prefs.order = words.map(w => w.id).sort(numericIdSort); prefs.presentation = null; selectFirstInActiveGroup(); save(); renderDashboard(); orderFeedback("resetOrder", "Zurückgesetzt ✓", "Die ursprüngliche Reihenfolge wurde wiederhergestellt."); });
    document.getElementById("resetDay").onclick = () => confirmDialog(`Lernstatus und Testergebnisse für Gruppe ${prefs.activeDay} zurücksetzen?`, () => { prefs.words = resetDayRecords(prefs.words, idsForGroup(prefs.activeDay)); save(); renderDashboard(); });
    document.getElementById("resetAll").onclick = () => confirmDialog("Wirklich alle Fortschritte, Zielwörter, Notizen, Einstellungen und die Reihenfolge zurücksetzen?", () => { root.localStorage.removeItem(STORAGE_KEY); prefs = defaultState(words.map(w => w.id)); syncGroupRange(true); transient.selectedId = null; save(); renderDashboard(); });
    ["helpButton", "helpLink"].forEach(id => document.getElementById(id).onclick = e => openHelp(e.currentTarget));
    document.querySelector("[data-action=navigation]").onclick = () => document.querySelector(".day-select")?.focus();
    document.getElementById("sprintButton").onclick = () => startTest(detailPool(), true);
    document.getElementById("paletteButton").onclick = e => openPalette(e.currentTarget);
    document.getElementById("retryMissed")?.addEventListener("click", () => startTest((prefs.lastTest?.missed || []).filter(id => wordMap.has(id)), false, prefs.lastTest?.group || null));
  }

  function openDialog(content, trigger, confirmed) {
    document.getElementById("appDialog")?.remove(); const returnTo = trigger || document.activeElement, dialog = document.createElement("dialog");
    dialog.id = "appDialog"; dialog.className = "app-dialog"; dialog.innerHTML = content; document.body.appendChild(dialog);
    const title = dialog.querySelector("h2"); if (title) { title.id = "appDialogTitle"; dialog.setAttribute("aria-labelledby", title.id); } else dialog.setAttribute("aria-label", "Dialog");
    const close = () => { dialog.close(); dialog.remove(); returnTo?.focus?.(); };
    dialog.querySelectorAll("[data-dialog-close]").forEach(b => b.onclick = close);
    dialog.querySelector("[data-dialog-confirm]")?.addEventListener("click", () => { close(); confirmed?.(); });
    dialog.oncancel = e => { e.preventDefault(); close(); };
    dialog.onkeydown = e => {
      if (e.key !== "Tab") return; const nodes = [...dialog.querySelectorAll("button,input,select,textarea,[tabindex]:not([tabindex='-1'])")].filter(n => !n.disabled);
      if (!nodes.length) return; if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0].focus(); }
    };
    dialog.showModal(); dialog.querySelector("button")?.focus();
  }
  function confirmDialog(message, callback) { openDialog(`<form method="dialog"><h2>Bestätigung</h2><p>${esc(message)}</p><div class="dialog-actions"><button type="button" data-dialog-close>Abbrechen</button><button type="button" class="danger" data-dialog-confirm>Bestätigen</button></div></form>`, document.activeElement, callback); }
  function openHelp(trigger) { openDialog(`<div><h2>So funktioniert Wortschatzberg</h2><ul><li>Tag N zeigt alle Gruppen vom gewählten Start bis N, jeweils sieben pro Zeile.</li><li>Mit <kbd>I</kbd>/<kbd>K</kbd> wechselst du das Wort, mit <kbd>J</kbd>/<kbd>L</kbd> die Gruppe.</li><li><kbd>G</kbd> markiert das Wort grün, <kbd>R</kbd> rot und <kbd>W</kbd> entfernt die Markierung.</li><li>Nur <kbd>D</kbd> öffnet die Definition als Pop-up; jede Taste schließt sie wieder.</li><li><kbd>T</kbd> markiert Zielwörter.</li><li>Die ausgewählten CEFR-Stufen bilden neue Gruppen mit mindestens 30 Wörtern. Bei mehreren Stufen enthält jede Gruppe Wörter aus allen gewählten Stufen.</li><li>Gruppentests und der 60-Sekunden-Sprint prüfen Deutsch nach Englisch.</li><li>Alle Daten bleiben in diesem Browser.</li></ul><button type="button" data-dialog-close>Schließen</button></div>`, trigger); }
  function openPalette(trigger) {
    openDialog(`<div><h2>Review-Farben</h2><div class="palette-options">${[["blue", "Blau"], ["purple", "Violett"], ["teal", "Petrol"]].map(([v, label]) => `<button type="button" data-palette="${v}" aria-pressed="${prefs.palette === v}">${label}</button>`).join("")}</div><button type="button" data-dialog-close>Schließen</button></div>`, trigger);
    document.querySelectorAll("#appDialog [data-palette]").forEach(b => b.onclick = () => { prefs.palette = b.dataset.palette; save(); document.getElementById("appDialog")?.remove(); renderDashboard(); });
  }
  function splitExample(text) { const m = String(text).match(/^(.*?)\s*\(([^()]*)\)\s*$/); return m ? { german: m[1], english: m[2] } : { german: text, english: "" }; }
  function emphasize(text, term) {
    const index = text.toLocaleLowerCase("de").indexOf(term.toLocaleLowerCase("de"));
    return index < 0 ? esc(text) : `${esc(text.slice(0, index))}<mark>${esc(text.slice(index, index + term.length))}</mark>${esc(text.slice(index + term.length))}`;
  }
  function renderDetail(id) {
    const w = wordMap.get(id); if (!w) return renderDashboard(); const r = recordFor(id), pool = transient.detailIds, index = pool.indexOf(id), ex = splitExample(w.example);
    document.getElementById("detailDialog")?.remove(); const dialog = document.createElement("dialog"); dialog.id = "detailDialog"; dialog.className = "detail-dialog"; dialog.setAttribute("aria-labelledby", "detailTitle");
    dialog.innerHTML = `<article id="detailView" class="detail-view${prefs.centerDefinition ? " is-centered" : ""}" data-palette="${prefs.palette}">
      <header class="detail-header"><div class="detail-title-wrap"><h1 id="detailTitle">${displayWord(w)}</h1><button id="speakButton" type="button"${("speechSynthesis" in root) ? "" : " disabled"} aria-label="${("speechSynthesis" in root) ? "Wort auf Deutsch vorlesen" : "Sprachausgabe nicht verfügbar"}">🔊</button></div><div><span class="dismiss-hint">Beliebige Taste schließt</span><button id="detailClose" type="button" aria-label="Definition schließen">×</button></div></header>
      <nav class="detail-actions" aria-label="Wortaktionen"><button id="markKnown" class="action-known${r.learned && r.lastResult === "correct" ? " is-active" : ""}" type="button">Gewusst</button><button id="markForgot" class="action-forgot${r.lastResult === "wrong" ? " is-active" : ""}" type="button">Vergessen</button><button id="wordReset" type="button">Zurücksetzen</button><button id="detailPrev" type="button"${index <= 0 ? " disabled" : ""}>← Zurück</button><button id="detailNext" type="button"${index < 0 || index >= pool.length - 1 ? " disabled" : ""}>Weiter →</button><button id="detailTarget" type="button" aria-pressed="${r.target}">${r.target ? "★ Zielwort" : "☆ Zur Zielliste"}</button></nav>
      <section class="detail-body">${w.pos ? `<h2>${esc(w.pos)}:</h2>` : ""}${w.english ? `<ul><li>${esc(w.english)}</li></ul>` : ""}${ex.german ? `<p class="detail-example"><em>${emphasize(ex.german, w.german)}</em></p>` : ""}${ex.english ? `<p class="example-translation">${esc(ex.english)}</p>` : ""}${w.mnemonic ? `<section class="mnemonic-section"><h2>Merkhilfe:</h2><p>${esc(w.mnemonic)}</p></section>` : ""}${w.notes ? `<section class="grammar-section"><h2>Grammatik:</h2><p>${esc(w.notes)}</p></section>` : ""}</section>
      <section class="detail-notes" aria-labelledby="notes-title"><h2 id="notes-title" class="sr-only">Persönliche Notizen</h2><textarea id="wordNote" placeholder="Notizen hier …" aria-label="Persönliche Notizen">${esc(r.note)}</textarea><p class="notes-info">Notizen werden nicht in einer Datenbank gespeichert, sondern nur auf diesem Gerät. Beim Wechsel des Browsers oder Löschen der Browserdaten können sie verloren gehen.</p></section><div id="liveRegion" class="sr-only" aria-live="polite"></div></article>`;
    document.body.appendChild(dialog); dialog.oncancel = event => { event.preventDefault(); closeDetail(); }; dialog.onclick = event => { if (event.target === dialog) closeDetail(); }; wireDetail(id); dialog.showModal();
    root.requestAnimationFrame(() => { const body = dialog.querySelector(".detail-body"); if (prefs.centerDefinition) body?.scrollIntoView({ block: "center" }); else dialog.scrollTop = 0; });
  }
  function openDetail(id) { if (!id || !wordMap.has(id)) return; if (transient.view !== "detail") { transient.returnScroll = root.scrollY; transient.detailIds = detailPool(); } transient.view = "detail"; transient.selectedId = id; transient.selectedGroup = groupForId(id); renderDetail(id); }
  function closeDetail() { const dialog = document.getElementById("detailDialog"); if (dialog?.open) dialog.close(); dialog?.remove(); transient.view = "dashboard"; renderDashboard(true); root.requestAnimationFrame(() => root.scrollTo(0, transient.returnScroll)); }
  function setWordResult(id, result) { const r = recordFor(id); if (result === "correct") { r.learned = true; r.lastResult = "correct"; } else if (result === "wrong") { r.learned = false; r.lastResult = "wrong"; } else { r.learned = false; r.lastResult = null; } save(); }
  function moveDetail(delta) { const pool = transient.detailIds, next = pool[pool.indexOf(transient.selectedId) + delta]; if (next) openDetail(next); }
  function speak(id) {
    if (!("speechSynthesis" in root)) return; root.speechSynthesis.cancel(); const u = new root.SpeechSynthesisUtterance(wordMap.get(id).german); u.lang = "de-DE";
    const voice = root.speechSynthesis.getVoices().find(v => v.lang?.toLowerCase().startsWith("de")); if (voice) u.voice = voice; root.speechSynthesis.speak(u);
  }
  function wireDetail(id) {
    document.getElementById("detailClose").onclick = closeDetail; document.getElementById("speakButton").onclick = () => speak(id);
    document.getElementById("markKnown").onclick = () => { setWordResult(id, "correct"); renderDetail(id); };
    document.getElementById("markForgot").onclick = () => { setWordResult(id, "wrong"); renderDetail(id); };
    document.getElementById("wordReset").onclick = () => { setWordResult(id, null); renderDetail(id); };
    document.getElementById("detailPrev").onclick = () => moveDetail(-1); document.getElementById("detailNext").onclick = () => moveDetail(1);
    document.getElementById("detailTarget").onclick = () => { recordFor(id).target = !recordFor(id).target; save(); renderDetail(id); };
    document.getElementById("wordNote").oninput = e => { recordFor(id).note = e.target.value; save(); };
  }
  function startTest(pool, sprint, group = null) {
    stopSprint(); const unique = [...new Set(pool)].filter(id => wordMap.has(id)); if (!unique.length) return announce("Für diesen Test sind keine Wörter sichtbar.");
    transient.test = { sprint, group, pool: unique, queue: fisherYates(unique), index: 0, answeredCount: 0, correct: 0, missed: [], answered: false, chosen: null, question: null, deadline: sprint ? Date.now() + 60000 : null };
    transient.view = "test"; if (sprint) transient.sprintInterval = root.setInterval(updateSprintClock, 250); renderTest();
  }
  function renderTest() {
    const test = transient.test; if (!test) return renderDashboard(); cycleSprintQueue(test); if (test.index >= test.queue.length || (test.sprint && Date.now() >= test.deadline)) return finishTest();
    const currentId = test.queue[test.index], question = test.question?.id === currentId ? test.question : (test.question = createQuestion(currentId, test.pool, wordMap)), w = wordMap.get(question.id), seconds = test.sprint ? Math.max(0, Math.ceil((test.deadline - Date.now()) / 1000)) : null;
    app.innerHTML = `<section id="testView" class="test-view"><header class="test-header"><div><h1>${test.sprint ? "60-Sekunden-Sprint" : `Test${test.group ? ` Gruppe ${test.group}` : ""}`}</h1><p>${test.index + 1} / ${test.queue.length} · ${test.correct} richtig ${test.sprint ? `· <span id="sprintClock">${seconds}</span> s` : ""}</p></div><button id="stopTest" type="button">${test.sprint ? "Sprint stoppen" : "Test verlassen"}</button></header><div class="test-question"><p>Was bedeutet …</p><h2>${displayWord(w)}</h2></div>
      ${question.options ? `<div class="test-options">${question.options.map(answer => `<button type="button" data-answer="${esc(answer)}"${test.answered ? " disabled" : ""}>${esc(answer)}</button>`).join("")}</div>` : `<div class="reveal-card">${test.answered ? `<p class="revealed-answer">${esc(w.english)}</p><button type="button" data-reveal-result="correct">Gewusst</button><button type="button" data-reveal-result="wrong">Vergessen</button>` : `<button id="revealAnswer" type="button">Antwort zeigen</button>`}</div>`}
      ${test.answered && question.options ? `<p class="answer-feedback ${test.chosen === w.english ? "is-correct" : "is-wrong"}">${test.chosen === w.english ? "Richtig" : `Richtig wäre: ${esc(w.english)}`}</p><button id="nextQuestion" type="button">Weiter</button>` : ""}<div id="liveRegion" class="sr-only" aria-live="polite"></div></section>`;
    document.getElementById("stopTest").onclick = () => finishTest(true);
    app.querySelectorAll("[data-answer]").forEach(b => b.onclick = () => { test.chosen = b.dataset.answer; test.answered = true; test.answeredCount += 1; const right = test.chosen === w.english; if (right) test.correct += 1; else test.missed.push(question.id); setWordResult(question.id, right ? "correct" : "wrong"); renderTest(); });
    document.getElementById("revealAnswer")?.addEventListener("click", () => { test.answered = true; renderTest(); });
    app.querySelectorAll("[data-reveal-result]").forEach(b => b.onclick = () => { const right = b.dataset.revealResult === "correct"; test.answeredCount += 1; if (right) test.correct += 1; else test.missed.push(question.id); setWordResult(question.id, right ? "correct" : "wrong"); advanceTest(); });
    document.getElementById("nextQuestion")?.addEventListener("click", advanceTest);
  }
  function advanceTest() { const test = transient.test; if (!test) return; test.index += 1; test.answered = false; test.chosen = null; test.question = null; renderTest(); }
  function updateSprintClock() {
    const test = transient.test; if (!test?.sprint) return stopSprint(); const seconds = Math.max(0, Math.ceil((test.deadline - Date.now()) / 1000));
    const clock = document.getElementById("sprintClock"); if (clock) clock.textContent = seconds; if (!seconds) finishTest();
  }
  function stopSprint() { if (transient.sprintInterval) root.clearInterval(transient.sprintInterval); transient.sprintInterval = null; }
  function finishTest(aborted = false) {
    const result = transient.test; if (!result) return renderDashboard(); stopSprint(); const total = result.answeredCount;
    prefs.lastTest = { correct: result.correct, total, missed: result.missed.slice(), group: result.group, sprint: result.sprint, date: new Date().toISOString() }; save(); transient.view = "result";
    app.innerHTML = `<section id="testView" class="test-view test-result"><h1>${aborted ? "Test beendet" : result.sprint ? "Sprint beendet" : "Test abgeschlossen"}</h1><p><strong>${result.correct}</strong> von <strong>${total}</strong> richtig</p>${result.missed.length ? `<button id="retryResult" type="button">Fehler wiederholen</button>` : ""}<button id="returnDashboard" type="button">Zurück zu Tag ${prefs.activeDay}</button><div id="liveRegion" class="sr-only" aria-live="polite"></div></section>`;
    document.getElementById("retryResult")?.addEventListener("click", () => startTest(result.missed, false, result.group));
    document.getElementById("returnDashboard").onclick = () => { transient.test = null; renderDashboard(); };
  }

  function globalKeydown(event) {
    if (transient.view === "detail" && shouldDismissDetail(event)) { event.preventDefault(); closeDetail(); return; }
    if (event.target.matches("input,textarea,select") || event.ctrlKey || event.metaKey || event.altKey || document.getElementById("appDialog")) return; const key = event.key.toLowerCase();
    if (transient.view === "dashboard") {
      if (key === "d") { event.preventDefault(); openDetail(transient.selectedId || detailPool()[0]); }
      else if (key === "t" && transient.selectedId) { event.preventDefault(); toggleTarget(transient.selectedId); }
      else {
        const result = dashboardResultForKey(event.key);
        if (result !== undefined && transient.selectedId) { event.preventDefault(); setWordResult(transient.selectedId, result); renderDashboard(true); announce(result === "correct" ? "Als gewusst markiert." : result === "wrong" ? "Als vergessen markiert." : "Markierung entfernt."); }
        else { const movement = dashboardMoveForKey(event.key); if (movement) { event.preventDefault(); moveDashboard(...movement); } }
      }
    } else if (event.key === "Escape" && transient.view === "test") { event.preventDefault(); finishTest(true); }
    else if (event.key === "Escape" && transient.view === "result") { event.preventDefault(); transient.test = null; renderDashboard(); }
  }
  async function init() {
    try {
      const response = await root.fetch("data/vocab.csv", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      words = normalizeWords(parseCSV(await response.text())); if (!words.length) throw new Error("Die CSV enthält keine Vokabeln."); wordMap = new Map(words.map(w => [w.id, w]));
      prefs = hydrateState(loadJSON(STORAGE_KEY, null), words.map(w => w.id), loadJSON(LEGACY_KEY, []), [...new Set(words.map(w => w.level).filter(Boolean))]); ensurePresentationOrder(); syncGroupRange(); save(); document.addEventListener("keydown", globalKeydown); renderDashboard();
    } catch (error) { app.innerHTML = `<section class="load-error" role="alert"><h1>Vokabeln konnten nicht geladen werden</h1><p>${esc(error.message)}</p><p>Starte die Seite über einen lokalen Webserver, damit <code>data/vocab.csv</code> geladen werden kann.</p></section>`; }
  }
  init();
})(typeof globalThis !== "undefined" ? globalThis : this);
