/* Wortschatzberg v3 browser UI: daily groups, controlled review, and practice. */
(function (root) {
  "use strict";
  const C = root.WortschatzCore, S = root.WortschatzSRS, document = root.document;
  const app = document?.getElementById("app");
  if (!app || !C || !S) return;
  const CEFR_LEVELS = ["A1", "A2", "B1", "B2"];

  let words = [], wordMap = new Map(), state, prefs;
  const transient = {
    view: "library", selectedId: null, selectedGroup: null, direction: "deEn",
    dueSelected: new Set(), dueOrder: [], selectionSignature: "", reviewCurrentScope: false, sessionId: null, test: null,
    sprintInterval: null, returnFocus: null, returnScroll: 0, detailOpen: false,
    detailDirection: "deEn", blockedKeys: new Set(), saveError: "", saveReason: "", pendingExpectedRevision: null,
    staleLocked: false,
  };

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const cssEsc = value => root.CSS?.escape ? root.CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const now = () => new Date();
  const today = () => S.dateKey(now(), state.studyTimeZone);
  const makeId = prefix => `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
  const wordState = id => state.words[String(id)];
  const displayGerman = word => `${word.article ? `${esc(word.article)} ` : ""}${esc(word.german)}`;
  const promptFor = (word, direction) => direction === "enDe" ? esc(word.english) : displayGerman(word);
  const directionLabel = direction => direction === "enDe" ? "EN → DE · Abrufen" : "DE → EN · Verstehen";
  const activeEventFor = task => [...state.reviewEvents].reverse().find(event => event.attemptId === task.attemptId && !event.undoneAt);

  function freshWord(previous = {}) {
    return { target: previous.target === true, learned: previous.learned === true,
      lastResult: ["correct", "wrong"].includes(previous.lastResult) ? previous.lastResult : null,
      note: typeof previous.note === "string" ? previous.note : "", introducedAt: previous.introducedAt || null,
      ambiguousProduction: previous.ambiguousProduction === true,
      tracks: { deEn: previous.tracks?.deEn || null, enDe: previous.tracks?.enDe || null } };
  }

  function libraryShapeErrors(library) {
    const errors = []; if (!library || typeof library !== "object" || Array.isArray(library)) return ["library must be an object"];
    if (library.order !== undefined && !Array.isArray(library.order)) errors.push("library.order must be an array");
    if (library.levels !== undefined && (!Array.isArray(library.levels) || library.levels.some(level => typeof level !== "string"))) errors.push("library.levels must be a string array");
    ["groupStart", "groupEnd", "activeDay"].forEach(key => { if (library[key] !== undefined && !Number.isInteger(library[key])) errors.push(`library.${key} must be an integer`); });
    ["includeLearned", "centerDefinition", "colorPreviousDays", "targetMode"].forEach(key => { if (library[key] !== undefined && typeof library[key] !== "boolean") errors.push(`library.${key} must be a boolean`); });
    if (library.listDirection !== undefined && !["deEn", "enDe"].includes(library.listDirection)) errors.push("library.listDirection is invalid");
    if (library.presentation != null && (typeof library.presentation !== "object" || typeof library.presentation.key !== "string" || !Array.isArray(library.presentation.order))) errors.push("library.presentation is invalid");
    const validLevels = new Set(CEFR_LEVELS);
    if (Array.isArray(library.levels) && library.levels.some(level => !validLevels.has(level))) errors.push("library.levels contains an unavailable level");
    return errors;
  }

  function normalizeLoadedState() {
    const defaults = C.defaultState(words.map(word => word.id));
    const library = { ...defaults, ...(state.library || {}) };
    delete library.version; delete library.words; delete library.lastTest;
    library.levels = C.cleanLevels(library.levels, library.level, CEFR_LEVELS);
    library.listDirection = C.cleanListDirection(library.listDirection);
    library.order = C.reconcileOrder(library.order, words.map(word => word.id));
    state.library = library; prefs = state.library;
    words.forEach(word => { state.words[word.id] = freshWord(state.words[word.id]); });
    state.batches ||= []; state.sessions ||= []; state.reviewEvents ||= []; state.dailyUndo ||= {};
    state.newGroupSkippedDate = typeof state.newGroupSkippedDate === "string" ? state.newGroupSkippedDate : null;
    syncRange(false);
  }

  function persist(nextState = state, expectedRevision = state.revision) {
    if (transient.staleLocked) { transient.saveError = "Die Daten wurden in einem anderen Tab geändert. Bitte neu laden."; transient.saveReason = "stale-revision"; if (document.getElementById("app")) renderCurrent(); return false; }
    const result = S.saveState(root.localStorage, nextState, expectedRevision);
    if (!result.saved) {
      if (result.reason === "storage-error" && result.pendingState) { state = result.pendingState; prefs = state.library; }
      transient.saveError = result.reason === "stale-revision" ? "Die Daten wurden in einem anderen Tab geändert. Bitte neu laden." : "Änderung konnte nicht gespeichert werden. Exportiere deine Daten in Einstellungen.";
      transient.saveReason = result.reason; transient.pendingExpectedRevision = result.reason === "storage-error" ? expectedRevision : null; if (result.reason === "stale-revision") transient.staleLocked = true;
      if (document.getElementById("app")) renderCurrent(); return false;
    }
    state = nextState; prefs = state.library; transient.saveError = ""; transient.saveReason = ""; transient.pendingExpectedRevision = null; return true;
  }

  function mutate(mutator) {
    const revision = state.revision, next = structuredClone(state); mutator(next); next.revision = revision + 1;
    return persist(next, revision);
  }

  function presentationKey() { return prefs.levels.length ? [...prefs.levels].sort().join("+") : "*"; }
  function presentationGroups() {
    const generated = C.buildLevelGroups(prefs.order, wordMap, prefs.levels).flat(), key = presentationKey();
    if (prefs.presentation?.key === key) prefs.presentation.order = C.reconcileOrder(prefs.presentation.order, generated);
    else prefs.presentation = { key, order: generated };
    return C.balancedPartition(prefs.presentation.order);
  }
  const groupCount = () => Math.max(1, presentationGroups().length);
  const idsForGroup = group => presentationGroups()[group - 1] || [];
  const rangeGroups = () => Array.from({ length: prefs.groupEnd - prefs.groupStart + 1 }, (_, index) => prefs.groupStart + index);
  const libraryGroups = () => C.dayWindow(prefs.activeDay, prefs.groupStart, prefs.groupEnd);
  function visibleIds(groups, applyPracticeFilters = true) {
    return groups.flatMap(idsForGroup).filter(id => !applyPracticeFilters || ((prefs.includeLearned || !wordState(id).learned) && (!prefs.targetMode || wordState(id).target)));
  }
  function syncRange(reset = false) {
    const maximum = groupCount();
    if (reset) { prefs.groupStart = 1; prefs.groupEnd = maximum; prefs.activeDay = 1; }
    else { const range = C.clampRange(prefs.groupStart, prefs.groupEnd, maximum, "end"); prefs.groupStart = range.start; prefs.groupEnd = range.end; prefs.activeDay = Math.min(range.end, Math.max(range.start, prefs.activeDay)); }
  }
  function groupForId(id) { const index = presentationGroups().findIndex(group => group.includes(String(id))); return index < 0 ? null : index + 1; }
  function rawDueTasks(direction) { return S.deriveDueTasks(state, now(), state.studyTimeZone, direction ? { directions: [direction] } : undefined); }
  function dueTasks(direction) { return rawDueTasks(direction).filter(task => wordMap.has(task.wordId)); }
  function dueMap() { const map = new Map(); dueTasks().forEach(task => { const list = map.get(task.wordId) || []; list.push(task); map.set(task.wordId, list); }); return map; }

  function topbar(active) {
    return `<header class="app-topbar"><a class="app-brand" href="#" data-view="library"><strong>Wortschatzberg</strong><span>Deutsch lernen</span></a><nav class="primary-tabs" aria-label="Hauptnavigation"><button data-view="library" aria-current="${active === "library" ? "page" : "false"}">Alle Gruppen</button></nav><button id="settingsButton" type="button">Einstellungen</button></header>`;
  }
  function shell(active, content) {
    app.innerHTML = `<div class="app-shell">${topbar(active)}${transient.saveError ? `<aside class="save-warning" role="alert">${esc(transient.saveError)} ${transient.saveReason === "storage-error" ? `<button id="retrySave" type="button">Erneut speichern</button><button id="emergencyExport" type="button">Daten exportieren</button>` : `<button id="reloadState" type="button">Neu laden</button>`}</aside>` : ""}${content}<div id="liveRegion" class="sr-only" aria-live="polite"></div></div>`;
    wireShell();
  }
  function wireShell() {
    app.querySelectorAll("[data-view]").forEach(button => button.onclick = event => { event.preventDefault(); transient.view = "library"; transient.sessionId = null; renderLibrary(); });
    document.getElementById("settingsButton")?.addEventListener("click", openSettings);
    document.getElementById("retrySave")?.addEventListener("click", () => { if (persist(state, transient.pendingExpectedRevision)) renderCurrent(); });
    document.getElementById("emergencyExport")?.addEventListener("click", exportData);
    document.getElementById("reloadState")?.addEventListener("click", () => location.reload());
  }
  function announce(message) { const live = document.getElementById("liveRegion"); if (live) { live.textContent = ""; root.setTimeout(() => { live.textContent = message; }, 10); } }

  function currentBatch() {
    const unfinished = [...state.batches].reverse().find(batch => batch.newWordIds.some(id => wordMap.has(id) && !wordState(id)?.introducedAt));
    return unfinished || null;
  }
  function recommendGroup() {
    const allocated = new Set(state.batches.flatMap(batch => batch.newWordIds));
    for (const group of rangeGroups()) {
      const ids = idsForGroup(group), fresh = ids.filter(id => !wordState(id).introducedAt && !allocated.has(id));
      if (fresh.length) return { group, ids, fresh };
    }
    return null;
  }
  function batchProgress(batch) {
    const available = batch ? batch.newWordIds.filter(id => wordMap.has(id)) : [];
    const attempted = available.filter(id => wordState(id)?.introducedAt).length;
    return { attempted, open: available.length - attempted, unavailable: batch ? batch.newWordIds.length - available.length : 0 };
  }
  function syncDueSelection(tasks) {
    const limit = state.reviewBatchSize === "all" ? tasks.length : state.reviewBatchSize;
    const signature = `${transient.direction}:${tasks.map(task => `${task.wordId}:${task.kind}:${task.retryAt || task.dueDate}`).join(",")}:${state.reviewBatchSize}`;
    if (signature !== transient.selectionSignature) {
      transient.dueSelected = new Set(tasks.slice(0, limit).map(task => `${task.wordId}|${task.direction}`)); transient.selectionSignature = signature;
      transient.dueOrder = tasks.map(task => `${task.wordId}|${task.direction}`);
    }
  }
  function orderDueTasks(tasks) {
    const positions = new Map(transient.dueOrder.map((key, index) => [key, index]));
    return tasks.slice().sort((a, b) => (positions.get(`${a.wordId}|${a.direction}`) ?? 1e9) - (positions.get(`${b.wordId}|${b.direction}`) ?? 1e9));
  }
  function taskListRows(tasks, selectable = false) {
    if (!tasks.length) return `<p class="empty-state">Heute nichts fällig.</p>`;
    return `<table class="review-list word-table"><caption class="sr-only">Ausgewählte Lernaufgaben</caption><tbody>${tasks.map(task => {
      const word = wordMap.get(task.wordId), key = `${task.wordId}|${task.direction}`;
      const accessiblePrompt = task.direction === "enDe" ? word.english : `${word.article ? `${word.article} ` : ""}${word.german}`;
      return `<tr class="word-row${task.wordId === transient.selectedId ? " is-selected" : ""}" data-id="${esc(task.wordId)}"><td>${selectable ? `<input type="checkbox" data-due-key="${esc(key)}" aria-label="${esc(accessiblePrompt)} auswählen"${transient.dueSelected.has(key) ? " checked" : ""}>` : ""}<button type="button" class="word-select" data-select-id="${esc(task.wordId)}">${promptFor(word, task.direction)}</button></td><td><span class="word-status is-due"><span class="status-dot is-due"></span>${task.frequentlyDifficult ? `<span class="difficult-badge">Häufig schwierig</span>` : ""}</span><small class="due-reason">${esc(task.reason || "Heute fällig")}</small></td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderToday() {
    stopSprint(); transient.view = "today";
    const unavailableDue = rawDueTasks().filter(task => !wordMap.has(task.wordId)).length;
    const allDue = dueTasks(), directionTasks = allDue.filter(task => task.direction === transient.direction), currentIds = new Set(visibleIds(rangeGroups(), false));
    const excludedByScope = directionTasks.filter(task => !currentIds.has(task.wordId)).length;
    let tasks = transient.reviewCurrentScope ? directionTasks.filter(task => currentIds.has(task.wordId)) : directionTasks; syncDueSelection(tasks); tasks = orderDueTasks(tasks);
    const retry = tasks.filter(task => task.kind === "retry");
    const selected = transient.dueSelected.size, batch = currentBatch(), skippedNew = !batch && state.newGroupSkippedDate === today(), recommendation = skippedNew ? null : recommendGroup(), progress = batchProgress(batch), tomorrow = S.addCalendarDays(today(), 1);
    const tomorrowCount = Object.values(state.words).reduce((sum, word) => sum + [word.tracks?.deEn, word.tracks?.enDe].filter(track => track?.dueDate === tomorrow).length, 0);
    const batchLabel = batch ? `${batch.sourceLevels.join(" + ") || "Alle Stufen"} · Gruppe ${batch.sourceGroup}` : recommendation ? `${prefs.levels.join(" + ") || "Alle Stufen"} · Gruppe ${recommendation.group}` : "Keine neue Gruppe";
    shell("today", `<section id="todayView" class="today-view"><section class="today-summary"><div><p>${new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: state.studyTimeZone }).format(now())}</p><h1>Dein Lernplan für heute</h1><p>${new Set(allDue.map(task => task.wordId)).size} Wörter · ${allDue.length} Aufgaben fällig</p></div><p>Morgen derzeit geplant: <strong>${tomorrowCount}</strong></p></section>
      ${legacyBanner()}${resumeBanner()}${unavailableDue ? `<aside class="save-warning">${unavailableDue} fällige Aufgaben gehören zu Wörtern, die nicht mehr in der CSV vorhanden sind. Ihr Verlauf bleibt gespeichert.</aside>` : ""}
      <section class="today-actions"><article class="metric-card"><span>Wiederholen</span><strong>${selected} ausgewählt</strong><small>${tasks.length} in ${directionLabel(transient.direction)}</small></article><article class="metric-card"><span>Neue Gruppe</span><strong>${batch ? batch.newWordIds.length : recommendation?.fresh.length || 0} Wörter</strong><small>${esc(batchLabel)}</small></article><button id="todaySprint" class="metric-card" type="button"><span>Sprint</span><strong>60 Sekunden</strong><small>Freies Üben</small></button></section>
      <div class="today-grid"><section class="today-panel"><header class="section-header"><div><h2>Fällige Wörter</h2><p>${tasks.length} Aufgaben · ${selected} ausgewählt</p></div><button id="startReview" type="button"${selected ? "" : " disabled"}>Wiederholen</button></header><div class="review-toolbar"><div class="direction-tabs"><button data-direction="deEn" aria-pressed="${transient.direction === "deEn"}">DE → EN</button><button data-direction="enDe" aria-pressed="${transient.direction === "enDe"}">EN → DE</button></div><label>Umfang <select id="batchSize"><option value="20"${state.reviewBatchSize === 20 ? " selected" : ""}>20</option><option value="40"${state.reviewBatchSize === 40 ? " selected" : ""}>40</option><option value="all"${state.reviewBatchSize === "all" ? " selected" : ""}>Alle</option></select></label><label><input id="reviewScope" type="checkbox"${transient.reviewCurrentScope ? " checked" : ""}> Nur aktuelle Stufen/Gruppen${excludedByScope ? ` (${excludedByScope} außerhalb)` : ""}</label><button id="toggleDue" type="button">Alle umschalten</button><button id="shuffleDue" type="button">Auswahl mischen</button></div>${taskListRows(tasks, true)}</section>
      <section class="today-panel"><header class="section-header"><div><h2>${batch && progress.open ? "Gruppe fortsetzen" : "Neue Gruppe heute"}</h2><p>${esc(batchLabel)}</p></div><button id="startGroup" type="button"${batch || recommendation ? "" : " disabled"}>${batch && progress.open ? "Fortsetzen" : state.batches.some(item => item.studyDate === today()) ? "Weitere Gruppe heute" : "Gruppe starten"}</button></header>${batch ? `<p>${progress.attempted} versucht · ${progress.open} offen${progress.unavailable ? ` · ${progress.unavailable} nicht mehr verfügbar` : ""}</p>${taskListRows(batch.newWordIds.filter(id => wordMap.has(id)).map(id => ({ wordId: id, direction: "deEn", reason: wordState(id).introducedAt ? "Heute versucht" : "Noch offen" })))}` : recommendation ? `<p>${recommendation.fresh.length} neu · ${recommendation.ids.length - recommendation.fresh.length} bereits begonnen</p>${taskListRows(recommendation.fresh.map(id => ({ wordId: id, direction: "deEn", reason: "Neu" })))}` : `<p class="empty-state">${skippedNew ? "Für heute sind nur Wiederholungen eingeplant." : "Alle Wörter im gewählten Bereich wurden begonnen."}</p>`}<button id="reviewOnly" type="button">${skippedNew ? "Neue Gruppe doch anzeigen" : "Heute nur wiederholen"}</button></section></div>
      ${retry.length ? `<section class="today-panel"><header class="section-header"><h2>Noch einmal heute</h2><span>${retry.length} bereit</span></header>${taskListRows(retry)}</section>` : ""}</section>`);
    wireToday(tasks, batch, recommendation);
  }

  function legacyBanner() {
    const migration = state.migration?.legacyBaseline;
    if (!migration || migration.status !== "pending" || !migration.eligibleWordIds?.length) return "";
    return `<aside class="migration-banner"><div><strong>Bisherige Markierungen übernehmen?</strong><p>${migration.eligibleWordIds.length} markierte Wörter können heute als Basis-Wiederholung eingeplant werden.</p></div><button id="importLegacy" type="button">Übernehmen</button><button id="declineLegacy" type="button">Nicht übernehmen</button></aside>`;
  }
  function unfinishedSession() { return [...state.sessions].reverse().find(session => !session.completedAt && session.tasks?.some(task => task.status === "open" && wordMap.has(task.wordId))) || null; }
  function resumeBanner() { const session = unfinishedSession(); return session ? `<aside class="migration-banner"><div><strong>Unfertige Sitzung</strong><p>${session.tasks.filter(task => task.status === "open" && wordMap.has(task.wordId)).length} Aufgaben sind noch offen.</p></div><button id="resumeSession" type="button">Fortsetzen</button></aside>` : ""; }
  function wireToday(tasks, batch, recommendation) {
    app.querySelectorAll("[data-direction]").forEach(button => button.onclick = () => { transient.direction = button.dataset.direction; transient.selectionSignature = ""; renderToday(); });
    app.querySelectorAll("[data-due-key]").forEach(box => box.onchange = () => { box.checked ? transient.dueSelected.add(box.dataset.dueKey) : transient.dueSelected.delete(box.dataset.dueKey); document.getElementById("startReview").disabled = !transient.dueSelected.size; });
    app.querySelectorAll("[data-select-id]").forEach(button => button.onclick = () => { transient.selectedId = button.dataset.selectId; renderToday(); });
    document.getElementById("batchSize").onchange = event => { mutate(next => { next.reviewBatchSize = event.target.value === "all" ? "all" : Number(event.target.value); }); transient.selectionSignature = ""; renderToday(); };
    document.getElementById("reviewScope").onchange = event => { transient.reviewCurrentScope = event.target.checked; transient.selectionSignature = ""; renderToday(); };
    document.getElementById("toggleDue").onclick = () => { const keys = tasks.map(task => `${task.wordId}|${task.direction}`), all = keys.every(key => transient.dueSelected.has(key)); keys.forEach(key => all ? transient.dueSelected.delete(key) : transient.dueSelected.add(key)); renderToday(); };
    document.getElementById("shuffleDue").onclick = () => { const selectedKeys = C.fisherYates(tasks.filter(task => transient.dueSelected.has(`${task.wordId}|${task.direction}`)).map(task => `${task.wordId}|${task.direction}`)); const unselectedKeys = tasks.filter(task => !transient.dueSelected.has(`${task.wordId}|${task.direction}`)).map(task => `${task.wordId}|${task.direction}`); transient.dueOrder = [...selectedKeys, ...unselectedKeys]; renderToday(); };
    document.getElementById("startReview").onclick = () => startSession("due", tasks.filter(task => transient.dueSelected.has(`${task.wordId}|${task.direction}`)));
    document.getElementById("startGroup").onclick = () => startDailyGroup(batch, recommendation);
    document.getElementById("reviewOnly").onclick = () => { mutate(next => { next.newGroupSkippedDate = next.newGroupSkippedDate === today() ? null : today(); }); renderToday(); };
    document.getElementById("todaySprint").onclick = () => startTest(visibleIds(rangeGroups(), false), true);
    document.getElementById("importLegacy")?.addEventListener("click", () => { const revision = state.revision, result = S.importLegacyBaseline(state, now(), state.studyTimeZone); persist(result.state, revision); renderToday(); });
    document.getElementById("declineLegacy")?.addEventListener("click", () => { mutate(next => { next.migration.legacyBaseline.status = "declined"; }); renderToday(); });
    document.getElementById("resumeSession")?.addEventListener("click", () => { const session = unfinishedSession(); if (!session) return; transient.sessionId = session.id; transient.selectedId = session.tasks.find(task => task.attemptId === session.selectedTaskId)?.wordId || session.tasks.find(task => task.status === "open")?.wordId; transient.view = "session"; renderSession(true); });
  }

  function startDailyGroup(batch, recommendation) {
    let selectedBatch = batch;
    if (!selectedBatch) {
      if (!recommendation) return;
      selectedBatch = { id: makeId("batch"), createdAt: now().toISOString(), studyDate: today(), sourceGroup: recommendation.group,
        sourceLevels: prefs.levels.slice(), sourceWordIds: recommendation.ids.slice(), newWordIds: recommendation.fresh.slice(), order: recommendation.fresh.slice() };
      mutate(next => { next.batches.push(selectedBatch); });
    }
    if (state.newGroupSkippedDate === today()) mutate(next => { next.newGroupSkippedDate = null; });
    const resumable = [...state.sessions].reverse().find(session => session.kind === "new" && session.batchId === selectedBatch.id && !session.completedAt && session.tasks.some(task => task.status === "open" && wordMap.has(task.wordId)));
    if (resumable) { transient.sessionId = resumable.id; transient.selectedId = resumable.tasks.find(task => task.attemptId === resumable.selectedTaskId)?.wordId || resumable.tasks.find(task => task.status === "open")?.wordId; transient.view = "session"; renderSession(true); return; }
    const open = selectedBatch.order.filter(id => wordMap.has(id) && !wordState(id).introducedAt);
    if (!open.length) return announce("Dieser Durchgang ist abgeschlossen.");
    startSession("new", open.map(wordId => ({ wordId, direction: "deEn", reason: "Neu", enroll: true })), selectedBatch.id);
  }

  function startSession(kind, sourceTasks, batchId = null) {
    if (!sourceTasks.length) return;
    if (transient.selectedId) { const index = sourceTasks.findIndex(task => String(task.wordId) === transient.selectedId); if (index > 0) sourceTasks = [sourceTasks[index], ...sourceTasks.slice(0, index), ...sourceTasks.slice(index + 1)]; }
    const session = { id: makeId("session"), createdAt: now().toISOString(), kind, direction: sourceTasks[0].direction,
      batchId, tasks: sourceTasks.map((task, index) => ({ wordId: String(task.wordId), direction: task.direction, reason: task.reason,
        enroll: task.enroll === true, attemptId: makeId(`attempt-${index}`), status: "open" })), selectedTaskId: null, order: sourceTasks.map(task => String(task.wordId)), excludedTaskIds: [], completedAt: null };
    session.selectedTaskId = session.tasks[0].attemptId;
    if (!mutate(next => { next.sessions.push(session); })) return;
    transient.sessionId = session.id; transient.selectedId = session.tasks[0].wordId; transient.view = "session"; renderSession();
  }

  function currentSession() { return state.sessions.find(session => session.id === transient.sessionId); }
  function availableSessionTasks(session) { return session?.tasks.filter(task => wordMap.has(task.wordId)) || []; }
  function renderSession(focus = false) {
    const session = currentSession(); if (!session) { transient.view = "library"; return renderLibrary(); }
    stopSprint(); transient.view = "session"; const tasks = availableSessionTasks(session), unavailable = session.tasks.length - tasks.length;
    if (!tasks.length) { transient.sessionId = null; transient.selectedId = null; transient.view = "library"; renderLibrary(); return announce("Diese Sitzung enthält keine Wörter aus der aktuellen CSV."); }
    const completed = tasks.filter(task => task.status === "completed").length, excluded = tasks.filter(task => task.status === "excluded").length, open = tasks.filter(task => task.status === "open").length;
    if (!tasks.some(task => task.wordId === transient.selectedId)) transient.selectedId = tasks.find(task => task.attemptId === session.selectedTaskId)?.wordId || tasks.find(task => task.status === "open")?.wordId || tasks[0]?.wordId || null;
    shell("today", `<section class="session-view"><header class="session-banner"><div><p>${session.kind === "new" ? "Neue Gruppe" : session.kind === "retry" ? "Erneut versuchen" : "Fällige Wiederholung"}</p><h1>${directionLabel(session.direction)}</h1><p>${completed} erledigt · ${open} offen${excluded ? ` · ${excluded} ausgeschlossen` : ""}${unavailable ? ` · ${unavailable} nicht mehr verfügbar` : ""}</p></div><button id="leaveSession" type="button">Zurück zu Heute</button></header><section class="today-panel"><table class="word-table session-table"><tbody>${tasks.map(task => sessionRow(task)).join("")}</tbody></table></section>${stickyActions(session)}</section>`);
    wireSession(); if (focus && transient.selectedId) document.querySelector(`[data-id="${cssEsc(transient.selectedId)}"]`)?.focus();
  }
  function sessionRow(task) {
    const word = wordMap.get(task.wordId), event = activeEventFor(task), classes = ["word-row"];
    if (task.wordId === transient.selectedId) classes.push("is-selected"); if (event) classes.push(event.grade === "correct" ? "is-correct" : "is-wrong");
    const status = task.status === "excluded" ? "Ausgeschlossen" : event ? event.grade === "correct" ? "Heute gewusst" : "Heute vergessen" : "Offen";
    return `<tr class="${classes.join(" ")}" data-id="${esc(task.wordId)}" tabindex="${task.wordId === transient.selectedId ? "0" : "-1"}" aria-selected="${task.wordId === transient.selectedId}"><td><button class="word-select" data-session-select="${esc(task.wordId)}" type="button">${promptFor(word, task.direction)}</button></td><td><span class="word-status ${task.status === "completed" ? "is-complete" : task.status === "excluded" ? "is-excluded" : "is-due"}"><span class="status-dot ${event ? `is-${event.grade}` : task.status === "excluded" ? "is-excluded" : "is-due"}"></span>${status}</span><small class="due-reason">${esc(task.reason || "Heute fällig")}</small></td></tr>`;
  }
  function stickyActions(session) {
    const excluded = session.tasks?.find(task => task.wordId === transient.selectedId)?.status === "excluded";
    return `<footer class="sticky-actions" aria-label="Lernaktionen"><span>I/K Wort · D Aufdecken</span><button data-rating="correct" type="button"${excluded ? " disabled" : ""}>G Gewusst</button><button data-rating="wrong" type="button"${excluded ? " disabled" : ""}>R Vergessen</button><button data-rating="undo" type="button"${excluded ? " disabled" : ""}>W Rückgängig</button><button id="nextOpen" type="button">Nächstes offenes Wort</button>${session.direction === "enDe" ? "" : `<button id="editNote" type="button">Notiz bearbeiten</button>`}${session.direction === "enDe" ? `<button id="markAmbiguous" type="button"${excluded ? " disabled" : ""}>Mehrdeutig ausschließen</button>` : ""}</footer>`;
  }
  function wireSession() {
    app.querySelectorAll("[data-session-select]").forEach(button => button.onclick = () => selectSessionWord(button.dataset.sessionSelect));
    app.querySelectorAll("[data-rating]").forEach(button => button.onclick = () => gradeSelected(button.dataset.rating));
    document.getElementById("nextOpen").onclick = selectNextOpen; document.getElementById("editNote")?.addEventListener("click", () => openNote(transient.selectedId));
    document.getElementById("markAmbiguous")?.addEventListener("click", () => { const task = selectedTask(); if (!task || task.status === "excluded") return; mutate(next => { next.words[task.wordId].ambiguousProduction = true; const session = next.sessions.find(item => item.id === transient.sessionId), stored = session?.tasks.find(item => item.attemptId === task.attemptId); if (stored) { stored.status = "excluded"; if (!session.excludedTaskIds.includes(stored.attemptId)) session.excludedTaskIds.push(stored.attemptId); if (session.tasks.every(item => item.status === "completed" || item.status === "excluded")) session.completedAt = now().toISOString(); } }); renderSession(true); });
    document.getElementById("leaveSession").onclick = () => { transient.view = "library"; transient.sessionId = null; renderLibrary(); };
  }
  function selectedTask() { const session = currentSession(); return session?.tasks.find(task => task.wordId === transient.selectedId); }
  function gradeSelected(rating) {
    const task = selectedTask(); if (!task) return; if (task.status === "excluded") return announce("Dieses mehrdeutige Wort ist für EN → DE ausgeschlossen.");
    if (rating === "undo") {
      const revision = state.revision, result = S.undoTodayAssessments(state, { wordId: task.wordId, direction: task.direction }, now(), state.studyTimeZone);
      if (result.applied) persist(result.state, revision); else setPractice(task.wordId, null); renderSession(true); return;
    }
    const revision = state.revision, result = S.applyScheduledGrade(state, { ...task, sessionId: currentSession().id, kind: currentSession().kind }, rating, now(), state.studyTimeZone);
    if (result.applied) persist(result.state, revision); renderSession(true);
  }
  function selectNextOpen() {
    const session = currentSession(), task = availableSessionTasks(session).find(item => item.status === "open"); if (!task) return announce("Durchgang abgeschlossen."); selectSessionWord(task.wordId);
  }
  function selectSessionWord(id) { const session = currentSession(), task = session?.tasks.find(item => item.wordId === id); if (!task) return; transient.selectedId = id; mutate(next => { const stored = next.sessions.find(item => item.id === transient.sessionId); if (stored) stored.selectedTaskId = task.attemptId; }); renderSession(true); }
  function moveSession(delta) {
    const tasks = availableSessionTasks(currentSession()); if (!tasks.length) return; const index = Math.max(0, tasks.findIndex(task => task.wordId === transient.selectedId));
    const next = tasks[Math.min(tasks.length - 1, Math.max(0, index + delta))]; if (next) selectSessionWord(next.wordId);
  }

  function pagerHTML() {
    const groups = rangeGroups();
    return `<nav class="day-pager" aria-label="Gruppennavigation"><button data-group-move="-1"${prefs.activeDay <= prefs.groupStart ? " disabled" : ""}>‹</button><label>Bis Gruppe <select class="day-select">${groups.map(group => `<option${group === prefs.activeDay ? " selected" : ""}>${group}</option>`).join("")}</select></label><button data-group-move="1"${prefs.activeDay >= prefs.groupEnd ? " disabled" : ""}>›</button><button data-group-move="3"${prefs.activeDay >= prefs.groupEnd ? " disabled" : ""}>+3</button></nav>`;
  }
  function renderLibrary(focus = false) {
    stopSprint(); transient.view = "library"; const groups = libraryGroups(), due = dueMap(), current = visibleIds(groups);
    if (!current.includes(transient.selectedId)) transient.selectedId = current[0] || null; transient.selectedGroup = groupForId(transient.selectedId);
    shell("library", `<section id="libraryView"><section class="library-toolbar"><fieldset><legend>Stufen</legend><label><input id="allLevels" type="checkbox"${prefs.levels.length ? "" : " checked"}> Alle</label>${CEFR_LEVELS.map(level => `<label><input data-level="${level}" type="checkbox"${prefs.levels.includes(level) ? " checked" : ""}> ${level}</label>`).join("")}</fieldset><label>Gruppe von <select id="groupStart">${groupOptions(prefs.groupStart)}</select></label><label>bis <select id="groupEnd">${groupOptions(prefs.groupEnd)}</select></label><label><input id="includeLearned" type="checkbox"${prefs.includeLearned ? " checked" : ""}> Markierte zeigen</label><button id="targetMode" aria-pressed="${prefs.targetMode}">${prefs.targetMode ? "Alle Wörter" : "Zielliste"}</button><button id="reverseWords" class="direction-toggle" aria-pressed="${prefs.listDirection === "enDe"}" aria-label="Wortlistenrichtung umkehren; aktuell ${prefs.listDirection === "enDe" ? "Englisch nach Deutsch" : "Deutsch nach Englisch"}" title="Listenrichtung umkehren">⇄ ${prefs.listDirection === "enDe" ? "EN → DE" : "DE → EN"}</button><button id="shuffleGroups">In Gruppen mischen</button><button id="shuffleAll">Gesamtliste mischen</button><button id="resetOrder">Reihenfolge</button><button id="librarySprint">Sprint</button></section>${pagerHTML()}<div id="groupColumns" class="group-columns" data-list-direction="${prefs.listDirection}">${groups.map(group => groupHTML(group, due)).join("")}</div>${pagerHTML()}${stickyActions({})}</section>`);
    wireLibrary(); if (focus && transient.selectedId) document.querySelector(`[data-id="${cssEsc(transient.selectedId)}"]`)?.focus();
  }
  function groupOptions(selected) { return Array.from({ length: groupCount() }, (_, index) => index + 1).map(group => `<option${group === selected ? " selected" : ""}>${group}</option>`).join(""); }
  function groupHTML(group, due) {
    const ids = visibleIds([group]), count = ids.reduce((sum, id) => sum + (due.get(id)?.length || 0), 0);
    return `<section class="group-column" data-group="${group}"><header class="group-column-header"><div><h2>Gruppe ${group}</h2><small>${ids.length} Wörter · ${count} fällig</small></div><button data-test-group="${group}">Test</button></header>${ids.length ? `<table class="word-table"><tbody>${ids.map(id => libraryRow(id, group, due.get(id))).join("")}</tbody></table>` : `<p class="group-empty">Keine Wörter entsprechen den Filtern.</p>`}</section>`;
  }
  function libraryRow(id, group, due) {
    const word = wordMap.get(id), record = wordState(id), classes = ["word-row"];
    if (id === transient.selectedId) classes.push("is-selected"); if (record.lastResult) classes.push(`is-${record.lastResult}`); if (prefs.colorPreviousDays && group < prefs.activeDay) classes.push("is-previous");
    return `<tr class="${classes.join(" ")}" data-id="${esc(id)}" data-group="${group}" tabindex="${id === transient.selectedId ? "0" : "-1"}"><td><button class="word-select" data-library-select="${esc(id)}">${record.target ? "★ " : ""}${esc(C.libraryPromptText(word, prefs.listDirection))}</button></td><td><span class="word-status ${due?.length ? "is-due" : ""}">${due?.length ? `<span class="status-dot is-due"></span>${due.length} fällig` : ""}</span><button class="target-toggle" data-target="${esc(id)}" aria-label="Zielliste umschalten">${record.target ? "★" : "☆"}</button></td></tr>`;
  }
  function wireLibrary() {
    app.querySelectorAll("[data-library-select]").forEach(button => button.onclick = () => { transient.selectedId = button.dataset.librarySelect; transient.selectedGroup = groupForId(transient.selectedId); renderLibrary(true); });
    app.querySelectorAll("[data-target]").forEach(button => button.onclick = () => toggleTarget(button.dataset.target));
    app.querySelectorAll("[data-test-group]").forEach(button => button.onclick = () => startTest(visibleIds([Number(button.dataset.testGroup)]), false, Number(button.dataset.testGroup)));
    app.querySelectorAll("[data-group-move]").forEach(button => button.onclick = () => moveGroup(Number(button.dataset.groupMove)));
    app.querySelectorAll(".day-select").forEach(select => select.onchange = event => { prefs.activeDay = Number(event.target.value); commitLibrary(); transient.selectedId = null; renderLibrary(); });
    document.getElementById("groupStart").onchange = event => setRange("start", event.target.value); document.getElementById("groupEnd").onchange = event => setRange("end", event.target.value);
    document.getElementById("allLevels").onchange = () => { prefs.levels = []; prefs.presentation = null; syncRange(true); commitLibrary(); transient.selectedId = null; renderLibrary(); };
    app.querySelectorAll("[data-level]").forEach(box => box.onchange = () => { const set = new Set(prefs.levels); box.checked ? set.add(box.dataset.level) : set.delete(box.dataset.level); prefs.levels = [...set]; prefs.presentation = null; syncRange(true); commitLibrary(); transient.selectedId = null; renderLibrary(); });
    document.getElementById("includeLearned").onchange = event => { prefs.includeLearned = event.target.checked; commitLibrary(); renderLibrary(); };
    document.getElementById("targetMode").onclick = () => { prefs.targetMode = !prefs.targetMode; commitLibrary(); transient.selectedId = null; renderLibrary(); };
    document.getElementById("reverseWords").onclick = () => { prefs.listDirection = prefs.listDirection === "enDe" ? "deEn" : "enDe"; commitLibrary(); renderLibrary(true); announce(prefs.listDirection === "enDe" ? "Englische Bedeutungen werden gezeigt. D zeigt das deutsche Wort." : "Deutsche Wörter werden gezeigt. D zeigt die Bedeutung."); };
    document.getElementById("shuffleGroups").onclick = () => { prefs.presentation = { key: presentationKey(), order: C.shuffleGroupRange(presentationGroups(), prefs.groupStart, prefs.groupEnd).flat() }; commitLibrary(); renderLibrary(); };
    document.getElementById("shuffleAll").onclick = () => confirmDialog("Gesamtliste mischen? Begonnene Tagesgruppen und Fälligkeiten bleiben erhalten.", () => { prefs.order = C.fisherYates(prefs.order); prefs.presentation = null; commitLibrary(); renderLibrary(); });
    document.getElementById("resetOrder").onclick = () => { prefs.order = words.map(word => word.id).sort(C.numericIdSort); prefs.presentation = null; commitLibrary(); renderLibrary(); };
    document.getElementById("librarySprint").onclick = () => startTest(visibleIds(rangeGroups()), true);
    app.querySelectorAll("[data-rating]").forEach(button => button.onclick = () => setPractice(transient.selectedId, button.dataset.rating === "undo" ? null : button.dataset.rating));
    document.getElementById("nextOpen").remove(); document.getElementById("editNote").onclick = () => openNote(transient.selectedId);
  }
  function commitLibrary() { const revision = state.revision; state.revision += 1; persist(state, revision); }
  function moveGroup(delta) { prefs.activeDay = Math.min(prefs.groupEnd, Math.max(prefs.groupStart, prefs.activeDay + delta)); commitLibrary(); transient.selectedId = null; renderLibrary(); }
  function setRange(changed, value) { const range = C.clampRange(changed === "start" ? value : prefs.groupStart, changed === "end" ? value : prefs.groupEnd, groupCount(), changed); prefs.groupStart = range.start; prefs.groupEnd = range.end; prefs.activeDay = Math.min(range.end, Math.max(range.start, prefs.activeDay)); commitLibrary(); transient.selectedId = null; renderLibrary(); }
  function toggleTarget(id) { mutate(next => { next.words[id].target = !next.words[id].target; }); if (prefs.targetMode && !wordState(id).target) transient.selectedId = null; renderLibrary(true); }
  function setPractice(id, result) { if (!id) return; mutate(next => { const record = next.words[id]; record.learned = result === "correct"; record.lastResult = result; }); renderCurrent(true); }
  function moveLibrary(vertical, horizontal) {
    const groups = libraryGroups(); let groupIndex = Math.max(0, groups.indexOf(transient.selectedGroup)), ids = visibleIds([groups[groupIndex]]), row = Math.max(0, ids.indexOf(transient.selectedId));
    if (horizontal) { let next = groupIndex; do { next += horizontal; ids = visibleIds([groups[next]]); } while (next >= 0 && next < groups.length && !ids.length); if (next < 0 || next >= groups.length || !ids.length) return; groupIndex = next; row = Math.min(row, ids.length - 1); }
    else row = Math.min(ids.length - 1, Math.max(0, row + vertical));
    if (ids[row]) { transient.selectedId = ids[row]; transient.selectedGroup = groups[groupIndex]; renderLibrary(true); }
  }

  function renderDetail(id, direction) {
    const word = wordMap.get(id); if (!word) return; const ex = splitExample(word.example), record = wordState(id), trigger = document.activeElement;
    transient.detailOpen = true; transient.detailDirection = direction; transient.returnFocus = trigger; transient.returnScroll = root.scrollY;
    const dialog = document.createElement("dialog"); dialog.id = "detailDialog"; dialog.className = `detail-dialog${prefs.centerDefinition ? " center-definition" : ""}`; dialog.setAttribute("aria-labelledby", "detailTitle");
    dialog.innerHTML = `<article id="detailView" class="detail-view"><header class="detail-header"><div class="detail-title-wrap"><h1 id="detailTitle">${displayGerman(word)}</h1><button id="speakButton" type="button" aria-label="Wort auf Deutsch vorlesen">🔊</button></div><button id="detailClose" type="button" aria-label="Definition schließen">×</button></header><section class="detail-body">${word.pos ? `<h2>${esc(word.pos)}:</h2>` : ""}${word.english ? `<ul><li>${esc(word.english)}</li></ul>` : ""}${ex.german ? `<p class="detail-example"><em>${emphasize(ex.german, word.german)}</em></p>` : ""}${ex.english ? `<p class="example-translation">${esc(ex.english)}</p>` : ""}${word.mnemonic ? `<section class="mnemonic-section"><h2>Merkhilfe:</h2><p>${esc(word.mnemonic)}</p></section>` : ""}${word.notes ? `<section class="grammar-section"><h2>Grammatik:</h2><p>${esc(word.notes)}</p></section>` : ""}${record.note ? `<section><h2>Notiz:</h2><p>${esc(record.note)}</p></section>` : ""}</section><footer class="detail-actions"><button id="detailNote" type="button">Notiz bearbeiten</button>${record.ambiguousProduction ? `<button id="restoreProduction" type="button">EN → DE wieder aktivieren</button>` : ""}<span>Beliebige Taste schließt</span></footer></article>`;
    document.body.appendChild(dialog); dialog.onclick = event => { if (event.target === dialog) closeDetail(); }; dialog.oncancel = event => { event.preventDefault(); closeDetail(); };
    document.getElementById("detailClose").onclick = closeDetail; document.getElementById("speakButton").onclick = () => speak(id); document.getElementById("detailNote").onclick = () => { closeDetail(false); openNote(id, transient.returnFocus); }; document.getElementById("restoreProduction")?.addEventListener("click", () => { const restored = mutate(next => { next.words[id].ambiguousProduction = false; }); closeDetail(false); if (restored) renderCurrent(true); }); dialog.showModal();
  }
  function closeDetail(restoreFocus = true) { const dialog = document.getElementById("detailDialog"); if (dialog?.open) dialog.close(); dialog?.remove(); transient.detailOpen = false; root.requestAnimationFrame(() => { if (restoreFocus) transient.returnFocus?.focus?.(); root.scrollTo(0, transient.returnScroll); announce("Definition geschlossen; G gewusst, R vergessen."); }); }
  function splitExample(text) { const match = String(text).match(/^(.*?)\s*\(([^()]*)\)\s*$/); return match ? { german: match[1], english: match[2] } : { german: text, english: "" }; }
  function emphasize(text, term) { const index = text.toLocaleLowerCase("de").indexOf(term.toLocaleLowerCase("de")); return index < 0 ? esc(text) : `${esc(text.slice(0, index))}<mark>${esc(text.slice(index, index + term.length))}</mark>${esc(text.slice(index + term.length))}`; }
  function speak(id) { if (!("speechSynthesis" in root)) return; root.speechSynthesis.cancel(); const utterance = new root.SpeechSynthesisUtterance(wordMap.get(id).german); utterance.lang = "de-DE"; root.speechSynthesis.speak(utterance); }
  function openNote(id, returnTo = document.activeElement) {
    if (!id) return; const dialog = document.createElement("dialog"); dialog.className = "note-dialog"; dialog.id = "appDialog"; dialog.setAttribute("aria-labelledby", "noteTitle");
    dialog.innerHTML = `<form method="dialog"><header class="section-header"><h2 id="noteTitle">Notiz · ${displayGerman(wordMap.get(id))}</h2><button value="close" aria-label="Schließen">×</button></header><textarea id="noteText" aria-label="Persönliche Notiz" placeholder="Notiz hier …">${esc(wordState(id).note)}</textarea><p id="noteSaveStatus" class="save-status">Gespeichert</p></form>`;
    document.body.appendChild(dialog); dialog.querySelector("textarea").oninput = event => { const ok = mutate(next => { next.words[id].note = event.target.value; }); dialog.querySelector(".save-status").textContent = ok ? "Gespeichert" : "Nicht gespeichert"; }; dialog.onclose = () => { dialog.remove(); returnTo?.focus?.(); }; dialog.showModal(); dialog.querySelector("textarea").focus();
  }

  function openDialog(html, confirmed) { document.getElementById("appDialog")?.remove(); const returnTo = document.activeElement, dialog = document.createElement("dialog"); dialog.id = "appDialog"; dialog.className = "app-dialog"; dialog.innerHTML = html; const title = dialog.querySelector("h2"); if (title) { title.id ||= "appDialogTitle"; dialog.setAttribute("aria-labelledby", title.id); } else dialog.setAttribute("aria-label", "Dialog"); document.body.appendChild(dialog); const close = () => { dialog.close(); dialog.remove(); returnTo?.focus?.(); }; dialog.querySelectorAll("[data-close]").forEach(button => button.onclick = close); dialog.querySelector("[data-confirm]")?.addEventListener("click", () => { close(); confirmed?.(); }); dialog.oncancel = event => { event.preventDefault(); close(); }; dialog.showModal(); dialog.querySelector("button,input,select,textarea")?.focus(); }
  function confirmDialog(message, callback) { openDialog(`<form method="dialog"><h2>Bestätigen</h2><p>${esc(message)}</p><div class="dialog-actions"><button type="button" data-close>Abbrechen</button><button type="button" class="danger" data-confirm>Bestätigen</button></div></form>`, callback); }
  function openSettings() {
    openDialog(`<form class="settings-panel"><h2>Einstellungen</h2><fieldset><legend>Lernrichtung</legend><label>Modus <select id="learningPolicy"><option value="staged"${state.learningPolicy === "staged" ? " selected" : ""}>Stufenweise</option><option value="recognitionOnly"${state.learningPolicy === "recognitionOnly" ? " selected" : ""}>Nur DE → EN</option><option value="bothFromStart"${state.learningPolicy === "bothFromStart" ? " selected" : ""}>Beide von Anfang an</option></select></label><label>Standardumfang <select id="settingsBatch"><option value="20"${state.reviewBatchSize === 20 ? " selected" : ""}>20</option><option value="40"${state.reviewBatchSize === 40 ? " selected" : ""}>40</option><option value="all"${state.reviewBatchSize === "all" ? " selected" : ""}>Alle</option></select></label></fieldset><section><h3>Darstellung</h3><label><span>Definition zentrieren</span><input id="centerDefinition" type="checkbox"${prefs.centerDefinition ? " checked" : ""}></label><label><span>Vorherige Gruppen markieren</span><input id="colorPreviousDays" type="checkbox"${prefs.colorPreviousDays ? " checked" : ""}></label></section><section><h3>Daten auf diesem Gerät</h3><p>${esc(location.origin)} · Zeitzone ${esc(state.studyTimeZone)}</p><button id="exportData" type="button">JSON exportieren</button><label>JSON importieren <input id="importData" type="file" accept="application/json"></label><button id="resetSchedule" type="button" class="danger-soft">Lernplan zurücksetzen</button><button id="resetAll" type="button" class="danger">Alle App-Daten löschen</button></section><button type="button" data-close>Schließen</button></form>`);
    document.getElementById("learningPolicy").onchange = event => { const revision = state.revision, changed = structuredClone(state); changed.learningPolicy = event.target.value; changed.revision += 1; const activated = S.activateEligibleProduction(changed, now(), changed.studyTimeZone); persist(activated.state, revision); };
    document.getElementById("settingsBatch").onchange = event => mutate(next => { next.reviewBatchSize = event.target.value === "all" ? "all" : Number(event.target.value); });
    document.getElementById("centerDefinition").onchange = event => { prefs.centerDefinition = event.target.checked; commitLibrary(); };
    document.getElementById("colorPreviousDays").onchange = event => { prefs.colorPreviousDays = event.target.checked; commitLibrary(); };
    document.getElementById("exportData").onclick = exportData; document.getElementById("importData").onchange = importData;
    document.getElementById("resetSchedule").onclick = () => confirmDialog("Lernplan und Fälligkeiten zurücksetzen? Notizen, Zielwörter und Bibliotheksreihenfolge bleiben erhalten.", resetSchedule);
    document.getElementById("resetAll").onclick = () => confirmDialog("Alle Fortschritte, Notizen, Einstellungen und lokalen Backups endgültig löschen?", resetAll);
  }
  function downloadText(filename, contents) { const blob = new Blob([contents], { type: "application/json" }), link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); root.setTimeout(() => URL.revokeObjectURL(link.href), 0); }
  function exportData() { downloadText(`wortschatzberg-${today()}.json`, JSON.stringify(state, null, 2)); }
  function prepareImport(parsed) {
    const candidate = structuredClone(parsed), checked = S.validateState(candidate); if (!checked.valid) throw new Error(checked.errors.join("; "));
    const library = candidate.library, validLevels = CEFR_LEVELS;
    if (!Array.isArray(library.order) || !Array.isArray(library.levels) || library.levels.some(level => !validLevels.includes(level))) throw new Error("Bibliotheksreihenfolge oder Stufen sind ungültig.");
    library.order = C.reconcileOrder(library.order, words.map(word => word.id));
    const maximum = Math.max(1, C.buildLevelGroups(library.order, wordMap, library.levels).length);
    if (![library.groupStart, library.groupEnd, library.activeDay].every(Number.isInteger) || library.groupStart < 1 || library.groupEnd > maximum || library.groupStart > library.groupEnd || library.activeDay < library.groupStart || library.activeDay > library.groupEnd) throw new Error("Der gespeicherte Gruppenbereich ist ungültig.");
    if (library.presentation !== null && library.presentation !== undefined && (typeof library.presentation.key !== "string" || !Array.isArray(library.presentation.order))) throw new Error("Die gespeicherte Gruppenansicht ist ungültig.");
    candidate.sessions.forEach(session => { if (!Array.isArray(session.order) || (session.selectedTaskId && !session.tasks.some(task => task.attemptId === session.selectedTaskId))) throw new Error(`Sitzung ${session.id} ist ungültig.`); });
    return candidate;
  }
  async function importData(event) { const file = event.target.files?.[0]; if (!file) return; try { const candidate = prepareImport(JSON.parse(await file.text())); document.getElementById("appDialog")?.remove(); openDialog(`<form method="dialog"><h2>Backup importieren?</h2><p>${Object.keys(candidate.words).length} Wörter, ${candidate.reviewEvents.length} Lernereignisse und ${candidate.sessions.length} Sitzungen ersetzen den aktuellen Stand.</p><div class="dialog-actions"><button type="button" data-close>Abbrechen</button><button type="button" data-confirm>Importieren</button></div></form>`, () => { try { root.localStorage.setItem(S.BACKUP_STORAGE_KEY, JSON.stringify(state)); root.localStorage.setItem(S.V3_STORAGE_KEY, JSON.stringify(candidate)); location.reload(); } catch (error) { alert(`Import fehlgeschlagen: ${error.message}`); } }); } catch (error) { alert(`Import fehlgeschlagen: ${error.message}`); } }
  function resetSchedule() { mutate(next => { Object.values(next.words).forEach(word => { word.introducedAt = null; word.tracks = { deEn: null, enDe: null }; }); next.batches = []; next.sessions = []; next.reviewEvents = []; next.dailyUndo = {}; }); document.getElementById("appDialog")?.remove(); renderLibrary(); }
  function resetAll() { try { [S.V3_STORAGE_KEY, S.V2_STORAGE_KEY, S.BACKUP_STORAGE_KEY].forEach(key => root.localStorage.removeItem(key)); const recoveryKeys = Array.from({ length: root.localStorage.length }, (_, index) => root.localStorage.key(index)).filter(key => key?.startsWith(`${S.V3_STORAGE_KEY}:invalid:`)); recoveryKeys.forEach(key => root.localStorage.removeItem(key)); location.reload(); } catch (error) { alert(`Löschen fehlgeschlagen: ${error.message}`); } }

  function startTest(pool, sprint, group = null) { stopSprint(); const unique = [...new Set(pool)].filter(id => wordMap.has(id)); if (!unique.length) return announce("Keine Wörter verfügbar."); transient.test = { sprint, group, pool: unique, queue: C.fisherYates(unique), index: 0, answeredCount: 0, correct: 0, missed: [], answered: false, chosen: null, question: null, deadline: sprint ? Date.now() + 60000 : null }; transient.view = "test"; if (sprint) transient.sprintInterval = root.setInterval(updateSprintClock, 250); renderTest(); }
  function renderTest() { const test = transient.test; if (!test) return renderLibrary(); C.cycleSprintQueue(test); if (test.index >= test.queue.length || (test.sprint && Date.now() >= test.deadline)) return finishTest(); const id = test.queue[test.index], question = test.question?.id === id ? test.question : (test.question = C.createQuestion(id, test.pool, wordMap)), word = wordMap.get(id), seconds = test.sprint ? Math.max(0, Math.ceil((test.deadline - Date.now()) / 1000)) : null;
    shell("", `<section class="test-view"><header class="test-header"><div><h1>${test.sprint ? "60-Sekunden-Sprint" : `Test Gruppe ${test.group}`}</h1><p>Freies Üben · verändert den Lernplan nicht</p><p>${test.index + 1}/${test.queue.length} · ${test.correct} richtig ${seconds !== null ? `· <span id="sprintClock">${seconds}</span>s` : ""}</p></div><button id="stopTest">Beenden</button></header><div class="test-question"><p>Was bedeutet …</p><h2>${displayGerman(word)}</h2></div>${question.options ? `<div class="test-options">${question.options.map(answer => `<button data-answer="${esc(answer)}"${test.answered ? " disabled" : ""}>${esc(answer)}</button>`).join("")}</div>` : `<div class="reveal-card">${test.answered ? `<p>${esc(word.english)}</p><button data-self="correct">Gewusst</button><button data-self="wrong">Vergessen</button>` : `<button id="revealAnswer">Antwort zeigen</button>`}</div>`}${test.answered && question.options ? `<p>${test.chosen === word.english ? "Richtig" : `Richtig: ${esc(word.english)}`}</p><button id="nextQuestion">Weiter</button>` : ""}</section>`); document.getElementById("stopTest").onclick = () => finishTest(true); app.querySelectorAll("[data-answer]").forEach(button => button.onclick = () => { test.chosen = button.dataset.answer; test.answered = true; test.answeredCount += 1; const right = test.chosen === word.english; if (right) test.correct += 1; else test.missed.push(id); setPracticeOnly(id, right ? "correct" : "wrong"); renderTest(); }); document.getElementById("revealAnswer")?.addEventListener("click", () => { test.answered = true; renderTest(); }); app.querySelectorAll("[data-self]").forEach(button => button.onclick = () => { test.answeredCount += 1; if (button.dataset.self === "correct") test.correct += 1; else test.missed.push(id); setPracticeOnly(id, button.dataset.self); advanceTest(); }); document.getElementById("nextQuestion")?.addEventListener("click", advanceTest); }
  function setPracticeOnly(id, result) { const revision = state.revision; state.words[id].learned = result === "correct"; state.words[id].lastResult = result; state.revision += 1; persist(state, revision); }
  function advanceTest() { transient.test.index += 1; transient.test.answered = false; transient.test.chosen = null; transient.test.question = null; renderTest(); }
  function updateSprintClock() { if (!transient.test?.sprint) return stopSprint(); const seconds = Math.max(0, Math.ceil((transient.test.deadline - Date.now()) / 1000)); const clock = document.getElementById("sprintClock"); if (clock) clock.textContent = seconds; if (!seconds) finishTest(); }
  function stopSprint() { if (transient.sprintInterval) root.clearInterval(transient.sprintInterval); transient.sprintInterval = null; }
  function finishTest(aborted = false) { const test = transient.test; if (!test) return renderLibrary(); stopSprint(); mutate(next => { next.lastTest = { correct: test.correct, total: test.answeredCount, missed: test.missed.slice(), group: test.group, sprint: test.sprint, date: now().toISOString() }; }); transient.test = null; transient.view = "library"; renderLibrary(); }

  function renderCurrent(focus = false) { if (transient.view === "session") renderSession(focus); else if (transient.view === "test") renderTest(); else renderLibrary(focus); }
  function renderRecovery(loaded, zone) {
    const hasBackup = root.localStorage.getItem(S.BACKUP_STORAGE_KEY) !== null, raw = loaded.raw || "";
    app.innerHTML = `<section class="load-error recovery-panel" role="alert"><h1>Gespeicherte Lerndaten sind beschädigt</h1><p>Wortschatzberg hat die Daten nicht überschrieben. Du kannst zuerst die Rohdaten exportieren oder ein Backup wiederherstellen.</p>${loaded.errors?.length ? `<details><summary>Technische Details</summary><ul>${loaded.errors.map(error => `<li>${esc(error)}</li>`).join("")}</ul></details>` : ""}<div class="dialog-actions"><button id="exportInvalid" type="button"${raw ? "" : " disabled"}>Beschädigte Daten exportieren</button><button id="restoreBackup" type="button"${hasBackup ? "" : " disabled"}>Backup wiederherstellen</button><button id="startFresh" class="danger" type="button">Neu beginnen</button></div><p id="recoveryStatus" class="save-status" aria-live="polite"></p></section>`;
    const status = document.getElementById("recoveryStatus");
    document.getElementById("exportInvalid").onclick = () => downloadText(`wortschatzberg-beschaedigt-${Date.now()}.json`, raw);
    document.getElementById("restoreBackup").onclick = () => { const result = S.restoreBackup(root.localStorage, now(), zone); if (result.restored) location.reload(); else status.textContent = `Backup konnte nicht wiederhergestellt werden: ${(result.errors || [result.reason]).join("; ")}`; };
    document.getElementById("startFresh").onclick = () => { if (!root.confirm("Wirklich einen neuen Lernplan beginnen? Exportiere beschädigte Daten vorher, wenn du sie behalten möchtest.")) return; try { if (raw) root.localStorage.setItem(`${S.V3_STORAGE_KEY}:invalid:${Date.now()}`, raw); const fresh = S.createDefaultState({ studyTimeZone: zone, wordIds: words.map(word => word.id) }); root.localStorage.setItem(S.V3_STORAGE_KEY, JSON.stringify(fresh)); location.reload(); } catch (error) { status.textContent = `Neustart fehlgeschlagen: ${error.message}`; } };
  }
  function keyboard(event) {
    const keyToken = event.code || event.key;
    if (transient.detailOpen) { event.preventDefault(); event.stopImmediatePropagation(); transient.blockedKeys.add(keyToken); closeDetail(); return; }
    if (transient.blockedKeys.has(keyToken) || event.isComposing || event.target.matches("input,textarea,select,[contenteditable=true]") || event.ctrlKey || event.metaKey || event.altKey || document.getElementById("appDialog")) return;
    if (event.repeat && ["g", "r", "w"].includes(event.key.toLowerCase())) return;
    const key = event.key.toLowerCase();
    if (["library", "session"].includes(transient.view)) {
      if (key === "d" && transient.selectedId) { event.preventDefault(); renderDetail(transient.selectedId, transient.view === "session" ? currentSession().direction : prefs.listDirection); return; }
      if (key === "t" && transient.selectedId) { event.preventDefault(); toggleTarget(transient.selectedId); return; }
      const rating = C.dashboardResultForKey(key); if (rating !== undefined && transient.selectedId) { event.preventDefault(); transient.view === "session" ? gradeSelected(rating === null ? "undo" : rating) : setPractice(transient.selectedId, rating); return; }
      const movement = C.dashboardMoveForKey(event.key); if (movement) { event.preventDefault(); transient.view === "session" ? moveSession(movement[0] || movement[1]) : moveLibrary(...movement); }
    } else if (key === "escape" && transient.view === "test") finishTest(true);
  }

  async function init() {
    try {
      const response = await fetch("data/vocab.csv", { cache: "no-store" }); if (!response.ok) throw new Error(`HTTP ${response.status}`);
      words = C.normalizeWords(C.parseCSV(await response.text())); wordMap = new Map(words.map(word => [word.id, word]));
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin", loaded = S.loadOrMigrate(root.localStorage, { now: now(), studyTimeZone: zone, wordIds: words.map(word => word.id) });
      if (!loaded.state) return renderRecovery(loaded, zone);
      const libraryErrors = libraryShapeErrors(loaded.state.library); if (libraryErrors.length) return renderRecovery({ ...loaded, raw: root.localStorage.getItem(S.V3_STORAGE_KEY), errors: libraryErrors }, zone);
      state = loaded.state; normalizeLoadedState(); const check = S.validateState(state); if (!check.valid) return renderRecovery({ ...loaded, raw: root.localStorage.getItem(S.V3_STORAGE_KEY), errors: check.errors }, zone);
      const stored = JSON.parse(root.localStorage.getItem(S.V3_STORAGE_KEY)); if (JSON.stringify(stored) !== JSON.stringify(state)) { const revision = state.revision; state.revision += 1; if (!persist(state, revision)) return; }
      document.addEventListener("keydown", keyboard, true); document.addEventListener("keyup", event => transient.blockedKeys.delete(event.code || event.key), true); root.addEventListener("storage", event => { if (event.key === S.V3_STORAGE_KEY) { transient.saveError = "Die Daten wurden in einem anderen Tab geändert. Bitte neu laden."; transient.saveReason = "stale-revision"; transient.pendingExpectedRevision = null; transient.staleLocked = true; renderCurrent(); } });
      transient.view = "library"; renderLibrary();
    } catch (error) { app.innerHTML = `<section class="load-error" role="alert"><h1>Wortschatzberg konnte nicht geladen werden</h1><p>${esc(error.message)}</p></section>`; }
  }
  init();
})(globalThis);
