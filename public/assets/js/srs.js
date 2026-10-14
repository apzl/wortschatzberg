/* Wortschatzberg v3 scheduler and migration core. No clock or storage reads in scheduling functions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WortschatzSRS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 3;
  const V2_STORAGE_KEY = "wortschatzberg:v2";
  const V3_STORAGE_KEY = "wortschatzberg:v3";
  const BACKUP_STORAGE_KEY = "wortschatzberg:v3:backup";
  const INTERVAL_DAYS = Object.freeze([1, 3, 7, 14, 30, 60]);
  const DIRECTIONS = Object.freeze(["deEn", "enDe"]);
  const POLICIES = Object.freeze(["staged", "recognitionOnly", "bothFromStart"]);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const asDate = value => {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date or timestamp");
    return date;
  };
  const isoTimestamp = value => asDate(value).toISOString();

  function isValidTimeZone(zone) {
    if (typeof zone !== "string" || !zone) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(0); return true; }
    catch (_) { return false; }
  }

  function dateKey(now, studyTimeZone) {
    if (!isValidTimeZone(studyTimeZone)) throw new RangeError(`Invalid IANA time zone: ${studyTimeZone}`);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: studyTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(asDate(now));
    const get = type => parts.find(part => part.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function validDateKey(value) {
    if (!DATE_RE.test(String(value))) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function addCalendarDays(studyDate, days) {
    if (!validDateKey(studyDate)) throw new TypeError(`Invalid study date: ${studyDate}`);
    if (!Number.isInteger(days)) throw new TypeError("days must be an integer");
    const [year, month, day] = studyDate.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function createTrack(dueDate, overrides) {
    if (isObject(dueDate)) { overrides = dueDate; dueDate = overrides.dueDate; }
    const values = isObject(overrides) ? overrides : {};
    if (!validDateKey(dueDate)) throw new TypeError("createTrack requires a valid dueDate");
    return {
      status: values.status || "new",
      step: Number.isInteger(values.step) ? values.step : -1,
      dueDate,
      retryAt: values.retryAt || null,
      lastReviewedAt: values.lastReviewedAt || null,
      lastReviewedDate: values.lastReviewedDate || null,
      lastResult: values.lastResult || null,
      lastAdvanceDate: values.lastAdvanceDate || null,
      successDatesSinceFailure: distinctDates(values.successDatesSinceFailure).slice(-2),
      lapseDates: distinctDates(values.lapseDates),
      attemptsDate: values.attemptsDate || null,
      attemptsOnDate: Number.isInteger(values.attemptsOnDate) ? values.attemptsOnDate : 0,
    };
  }

  function distinctDates(values) {
    return [...new Set(Array.isArray(values) ? values.filter(validDateKey) : [])].sort();
  }

  function createDefaultState(options) {
    const input = isObject(options) ? options : {};
    const zone = input.studyTimeZone || input.zone || "UTC";
    if (!isValidTimeZone(zone)) throw new RangeError(`Invalid IANA time zone: ${zone}`);
    const state = {
      version: VERSION,
      revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
      studyTimeZone: zone,
      learningPolicy: POLICIES.includes(input.learningPolicy) ? input.learningPolicy : "staged",
      reviewBatchSize: [20, 40, "all"].includes(input.reviewBatchSize) ? input.reviewBatchSize : 40,
      library: clone(input.library) || {},
      words: {},
      batches: [],
      sessions: [],
      reviewEvents: [],
      dailyUndo: {},
      lastTest: clone(input.lastTest) || null,
      migration: clone(input.migration) || null,
    };
    (Array.isArray(input.wordIds) ? input.wordIds : []).forEach(id => { state.words[String(id)] = createWordState(); });
    return state;
  }

  function createWordState(practice) {
    const value = isObject(practice) ? practice : {};
    return {
      target: value.target === true,
      learned: value.learned === true,
      lastResult: ["correct", "wrong"].includes(value.lastResult) ? value.lastResult : null,
      note: typeof value.note === "string" ? value.note : "",
      introducedAt: typeof value.introducedAt === "string" ? value.introducedAt : null,
      ambiguousProduction: value.ambiguousProduction === true,
      tracks: {
        deEn: value.tracks?.deEn ? clone(value.tracks.deEn) : null,
        enDe: value.tracks?.enDe ? clone(value.tracks.enDe) : null,
      },
    };
  }

  function activationEligibility(stateOrWord, wordId, policy) {
    const stateShape = isObject(stateOrWord) && isObject(stateOrWord.words);
    const word = stateShape ? stateOrWord.words[String(wordId)] : stateOrWord;
    const learningPolicy = policy || (stateShape ? stateOrWord.learningPolicy : "staged");
    if (!word || word.ambiguousProduction || word.tracks?.enDe) return false;
    if (learningPolicy === "recognitionOnly") return false;
    if (learningPolicy === "bothFromStart") return Boolean(word.introducedAt || word.tracks?.deEn);
    return distinctDates(word.tracks?.deEn?.successDatesSinceFailure).length >= 2;
  }

  function activateEligibleProduction(state, now, zone) {
    if (!isObject(state) || state.version !== VERSION) throw new TypeError("A v3 state is required");
    const next = clone(state), dueDate = addCalendarDays(dateKey(now, zone || state.studyTimeZone), 1), activatedWordIds = [];
    Object.entries(next.words).forEach(([wordId, word]) => {
      if (!activationEligibility(next, wordId)) return;
      word.tracks.enDe = createTrack(dueDate); activatedWordIds.push(wordId);
    });
    if (activatedWordIds.length) next.revision += 1;
    return { state: activatedWordIds.length ? next : state, activatedWordIds };
  }

  function eventForAttempt(events, attemptId) {
    return events.find(event => event.attemptId === attemptId && !event.undoneAt);
  }

  function lookupSessionKind(state, attempt) {
    if (attempt.kind) return attempt.kind;
    return state.sessions.find(session => session.id === attempt.sessionId)?.kind || null;
  }

  function gradeArguments(attempt, grade, now, zone, state) {
    // Also accepts applyScheduledGrade(state, {...attempt, grade}, now, zone).
    if (!(["correct", "wrong", "G", "R"].includes(grade)) && attempt?.grade) {
      zone = now; now = grade; grade = attempt.grade;
    }
    const normalized = grade === "G" ? "correct" : grade === "R" ? "wrong" : grade;
    if (!["correct", "wrong"].includes(normalized)) throw new TypeError("grade must be correct/wrong or G/R");
    return { grade: normalized, now, zone: zone || state.studyTimeZone };
  }

  function applyScheduledGrade(state, attempt, grade, now, zone) {
    if (!isObject(state) || state.version !== VERSION) throw new TypeError("A v3 state is required");
    if (!isObject(attempt)) throw new TypeError("attempt is required");
    const args = gradeArguments(attempt, grade, now, zone, state);
    const at = isoTimestamp(args.now), today = dateKey(args.now, args.zone);
    const wordId = String(attempt.wordId ?? ""), direction = attempt.direction;
    if (!wordId || !DIRECTIONS.includes(direction) || !attempt.attemptId) throw new TypeError("attempt needs wordId, direction, and attemptId");
    if (eventForAttempt(state.reviewEvents || [], String(attempt.attemptId))) {
      return { state, event: null, applied: false, scheduled: false, reason: "duplicate-attempt" };
    }
    const next = clone(state), word = next.words[wordId];
    if (!word) return { state, event: null, applied: false, scheduled: false, reason: "unknown-word" };
    if (!word.tracks) word.tracks = { deEn: null, enDe: null };
    if (direction === "enDe" && word.ambiguousProduction) return practiceResult(next, attempt, args.grade, at, today, "ambiguous-production");

    const kind = lookupSessionKind(next, attempt);
    let track = word.tracks[direction];
    const enrolling = !track && (kind === "new" || kind === "legacyBaseline" || attempt.enroll === true);
    if (enrolling) track = createTrack(today);
    const retryReady = Boolean(track?.retryAt && new Date(track.retryAt).getTime() <= asDate(args.now).getTime());
    const retryWaiting = Boolean(track?.retryAt && !retryReady);
    const normalDue = Boolean(track && !track.retryAt && track.dueDate <= today && track.lastAdvanceDate !== today);
    if (!track || (!enrolling && !retryReady && (!normalDue || retryWaiting))) {
      return practiceResult(next, attempt, args.grade, at, today, retryWaiting ? "retry-not-ready" : "not-due");
    }

    const undoKey = dailyUndoKey(wordId, direction, today);
    if (!next.dailyUndo[undoKey]) {
      next.dailyUndo[undoKey] = {
        wordId, direction, studyDate: today,
        track: clone(word.tracks[direction]),
        introducedAt: word.introducedAt || null,
        productionTrack: direction === "deEn" ? clone(word.tracks.enDe) : undefined,
      };
    }
    const before = clone(word.tracks[direction]);
    track = createTrack(track.dueDate, track);
    if (track.attemptsDate !== today) { track.attemptsDate = today; track.attemptsOnDate = 0; }
    track.attemptsOnDate = Math.min(3, track.attemptsOnDate + 1);
    track.lastReviewedAt = at; track.lastReviewedDate = today; track.lastResult = args.grade;
    track.lapseDates = distinctDates(track.lapseDates).filter(date => date >= addCalendarDays(today, -13) && date <= today);

    if (args.grade === "wrong") {
      track.status = "relearning"; track.step = -1; track.dueDate = today;
      track.successDatesSinceFailure = [];
      track.lapseDates = distinctDates([...track.lapseDates, today]);
      if (track.attemptsOnDate >= 3) { track.retryAt = null; track.dueDate = addCalendarDays(today, 1); }
      else track.retryAt = new Date(asDate(args.now).getTime() + 10 * 60 * 1000).toISOString();
    } else {
      const recovery = retryReady || track.status === "relearning" || track.step < 0;
      track.step = recovery ? 0 : Math.min(5, track.step + 1);
      track.status = "review"; track.retryAt = null; track.dueDate = addCalendarDays(today, INTERVAL_DAYS[track.step]);
      track.lastAdvanceDate = today;
      track.successDatesSinceFailure = distinctDates([...track.successDatesSinceFailure, today]).slice(-2);
    }
    word.tracks[direction] = track;
    if (!word.introducedAt) word.introducedAt = at;

    let activatedProduction = false;
    if (direction === "deEn" && activationEligibility(next, wordId)) {
      word.tracks.enDe = createTrack(addCalendarDays(today, 1)); activatedProduction = true;
    }
    const event = makeEvent(next, attempt, args.grade, at, today, before, track, "scheduled", activatedProduction);
    next.reviewEvents.push(event);
    completeSessionTask(next, attempt, event.id);
    next.revision += 1;
    return { state: next, event, applied: true, scheduled: true, reason: retryReady ? "retry" : enrolling ? "enrolled" : "due" };
  }

  function practiceResult(next, attempt, grade, at, today, reason) {
    const word = next.words[String(attempt.wordId)];
    word.learned = grade === "correct"; word.lastResult = grade;
    const event = makeEvent(next, attempt, grade, at, today, null, null, "practice", false);
    next.reviewEvents.push(event); next.revision += 1;
    return { state: next, event, applied: true, scheduled: false, reason };
  }

  function makeEvent(state, attempt, grade, at, studyDate, before, after, source, activatedProduction) {
    const attemptId = String(attempt.attemptId);
    const number = state.reviewEvents.filter(event => event.attemptId === attemptId).length + 1;
    return {
      id: attempt.eventId || `event:${attemptId}:${number}`,
      wordId: String(attempt.wordId), direction: attempt.direction,
      sessionId: attempt.sessionId || null, attemptId, at, studyDate, grade,
      source: attempt.source || source, before: clone(before), after: clone(after),
      activatedProduction: activatedProduction === true, undoneAt: null,
    };
  }

  function completeSessionTask(state, attempt, eventId) {
    const session = state.sessions.find(item => item.id === attempt.sessionId); if (!session) return;
    const task = session.tasks.find(item => item.attemptId === String(attempt.attemptId));
    if (task) { task.status = "completed"; task.eventId = eventId; }
    if (session.tasks.length && session.tasks.every(item => item.status === "completed" || item.status === "excluded")) session.completedAt = state.reviewEvents.at(-1)?.at || null;
  }

  function dailyUndoKey(wordId, direction, studyDate) { return `${wordId}|${direction}|${studyDate}`; }

  function undoTodayAssessments(state, target, now, zone) {
    if (!isObject(state) || state.version !== VERSION) throw new TypeError("A v3 state is required");
    const args = isObject(target) ? target : { wordId: target, direction: arguments[2] };
    if (!isObject(target)) { now = arguments[3]; zone = arguments[4]; }
    const wordId = String(args.wordId ?? ""), direction = args.direction;
    if (!wordId || !DIRECTIONS.includes(direction)) throw new TypeError("target needs wordId and direction");
    const at = isoTimestamp(now), today = dateKey(now, zone || state.studyTimeZone), key = dailyUndoKey(wordId, direction, today);
    const snapshot = state.dailyUndo?.[key];
    if (!snapshot) return { state, undoneEvents: [], applied: false, reason: "nothing-to-undo" };
    const next = clone(state), word = next.words[wordId]; if (!word) return { state, undoneEvents: [], applied: false, reason: "unknown-word" };
    const undoneEvents = [];
    next.reviewEvents.forEach(event => {
      if (event.wordId === wordId && event.direction === direction && event.studyDate === today && event.source !== "practice" && !event.undoneAt) {
        event.undoneAt = at; undoneEvents.push(event.id);
      }
    });
    word.tracks[direction] = clone(snapshot.track);
    word.introducedAt = snapshot.introducedAt || null;
    if (direction === "deEn" && snapshot.productionTrack === null && word.tracks.enDe) {
      const independentProduction = next.reviewEvents.some(event => event.wordId === wordId && event.direction === "enDe" && event.source !== "practice" && !event.undoneAt);
      if (!independentProduction) word.tracks.enDe = null;
    }
    next.sessions.forEach(session => {
      session.tasks.forEach(task => { if (undoneEvents.includes(task.eventId)) { task.status = "open"; delete task.eventId; } });
      if (session.tasks.some(task => task.status === "open")) session.completedAt = null;
    });
    delete next.dailyUndo[key]; next.revision += 1;
    return { state: next, undoneEvents, applied: true, reason: "restored" };
  }

  function deriveDueTasks(state, now, zone, options) {
    if (!isObject(state) || state.version !== VERSION) throw new TypeError("A v3 state is required");
    const today = dateKey(now, zone || state.studyTimeZone), timestamp = asDate(now).getTime(), input = isObject(options) ? options : {};
    const allowedDirections = new Set(input.directions || DIRECTIONS);
    const tasks = [];
    Object.entries(state.words).forEach(([wordId, word]) => DIRECTIONS.forEach(direction => {
      if (!allowedDirections.has(direction) || (direction === "enDe" && word.ambiguousProduction)) return;
      if (direction === "enDe" && state.learningPolicy === "recognitionOnly" && !input.includePausedProduction) return;
      const track = word.tracks?.[direction]; if (!track) return;
      let kind = null;
      if (track.retryAt) { if (new Date(track.retryAt).getTime() <= timestamp) kind = "retry"; else return; }
      else if (track.dueDate <= today) kind = "due";
      if (!kind) return;
      const daysOverdue = kind === "due" ? calendarDayDifference(track.dueDate, today) : 0;
      tasks.push({ wordId, direction, kind, dueDate: track.dueDate, retryAt: track.retryAt,
        reason: kind === "retry" ? "Erneut versuchen" : daysOverdue ? `${daysOverdue} Tage überfällig` : "Heute fällig",
        daysOverdue, lastResult: track.lastResult, frequentlyDifficult: isFrequentlyDifficult(track, today) });
    }));
    return tasks.sort((a, b) => {
      const retryOrder = Number(a.kind === "retry") - Number(b.kind === "retry");
      if (retryOrder) return retryOrder;
      if (a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      const wrong = Number(b.lastResult === "wrong") - Number(a.lastResult === "wrong"); if (wrong) return wrong;
      const idOrder = numericCompare(a.wordId, b.wordId); return idOrder || a.direction.localeCompare(b.direction);
    });
  }

  function calendarDayDifference(from, to) {
    const parse = value => { const [y, m, d] = value.split("-").map(Number); return Date.UTC(y, m - 1, d); };
    return Math.max(0, Math.round((parse(to) - parse(from)) / 86400000));
  }
  function numericCompare(a, b) { const an = Number(a), bn = Number(b); return Number.isFinite(an) && Number.isFinite(bn) && an !== bn ? an - bn : String(a).localeCompare(String(b), "de", { numeric: true }); }
  function isFrequentlyDifficult(track, today) { return distinctDates(track.lapseDates).filter(date => date >= addCalendarDays(today, -13) && date <= today).length >= 3; }

  function migrateV2(v2, now, studyTimeZone) {
    if (!isObject(v2) || (v2.version !== undefined && v2.version !== 2)) throw new TypeError("A v2 state is required");
    const { version: ignoredVersion, words: oldWords, lastTest, ...library } = v2;
    const state = createDefaultState({ studyTimeZone, library, lastTest, migration: { sourceVersion: 2, migratedAt: isoTimestamp(now), legacyBaseline: { status: "pending", eligibleWordIds: [] } } });
    Object.entries(isObject(oldWords) ? oldWords : {}).forEach(([id, value]) => {
      state.words[String(id)] = createWordState(value);
      if (value?.learned === true || ["correct", "wrong"].includes(value?.lastResult)) state.migration.legacyBaseline.eligibleWordIds.push(String(id));
    });
    return state;
  }

  function importLegacyBaseline(state, now, zone, wordIds) {
    const next = clone(state), at = isoTimestamp(now), today = dateKey(now, zone || state.studyTimeZone);
    const eligible = state.migration?.legacyBaseline?.eligibleWordIds || [];
    const requested = new Set((wordIds || eligible).map(String)); let count = 0;
    eligible.forEach(id => {
      const word = next.words[id]; if (!requested.has(id) || !word || word.tracks.deEn) return;
      word.introducedAt = at; word.tracks.deEn = createTrack(today); count += 1;
    });
    if (next.migration?.legacyBaseline) { next.migration.legacyBaseline.status = "imported"; next.migration.legacyBaseline.importedAt = at; next.migration.legacyBaseline.importedCount = count; }
    if (count) next.revision += 1; return { state: next, count };
  }

  function validateState(state) {
    const errors = [];
    if (!isObject(state)) return { valid: false, errors: ["state must be an object"] };
    if (state.version !== VERSION) errors.push("version must be 3");
    if (!Number.isInteger(state.revision) || state.revision < 0) errors.push("revision must be a non-negative integer");
    if (!isValidTimeZone(state.studyTimeZone)) errors.push("studyTimeZone must be a valid IANA zone");
    if (!POLICIES.includes(state.learningPolicy)) errors.push("learningPolicy is invalid");
    if (![20, 40, "all"].includes(state.reviewBatchSize)) errors.push("reviewBatchSize is invalid");
    if (!isObject(state.library)) errors.push("library must be an object");
    if (!isObject(state.words)) errors.push("words must be an object");
    else Object.entries(state.words).forEach(([id, word]) => validateWord(id, word, errors));
    ["batches", "sessions", "reviewEvents"].forEach(key => { if (!Array.isArray(state[key])) errors.push(`${key} must be an array`); });
    if (!isObject(state.dailyUndo)) errors.push("dailyUndo must be an object");
    else Object.entries(state.dailyUndo).forEach(([key, snapshot]) => validateUndo(key, snapshot, errors));
    if (Array.isArray(state.batches)) state.batches.forEach((batch, i) => validateBatch(batch, i, errors));
    if (Array.isArray(state.reviewEvents)) state.reviewEvents.forEach((event, i) => validateEvent(event, i, errors));
    if (Array.isArray(state.sessions)) state.sessions.forEach((session, i) => validateSession(session, i, state.reviewEvents || [], errors));
    return { valid: errors.length === 0, errors };
  }

  function validateWord(id, word, errors) {
    if (!isObject(word)) { errors.push(`words.${id} must be an object`); return; }
    if (typeof word.note !== "string" || typeof word.target !== "boolean" || typeof word.learned !== "boolean") errors.push(`words.${id} practice fields are invalid`);
    if (![null, "correct", "wrong"].includes(word.lastResult)) errors.push(`words.${id}.lastResult is invalid`);
    if (word.introducedAt !== null && !validTimestamp(word.introducedAt)) errors.push(`words.${id}.introducedAt is invalid`);
    if (!isObject(word.tracks)) errors.push(`words.${id}.tracks is invalid`);
    else DIRECTIONS.forEach(direction => { if (word.tracks[direction] !== null) validateTrack(word.tracks[direction], `words.${id}.tracks.${direction}`, errors); });
  }
  function validateTrack(track, path, errors) {
    if (!isObject(track)) { errors.push(`${path} must be an object`); return; }
    if (!["new", "review", "relearning"].includes(track.status)) errors.push(`${path}.status is invalid`);
    if (!Number.isInteger(track.step) || track.step < -1 || track.step > 5) errors.push(`${path}.step is invalid`);
    if (!validDateKey(track.dueDate)) errors.push(`${path}.dueDate is invalid`);
    ["retryAt", "lastReviewedAt"].forEach(key => { if (track[key] !== null && !validTimestamp(track[key])) errors.push(`${path}.${key} is invalid`); });
    ["lastReviewedDate", "lastAdvanceDate", "attemptsDate"].forEach(key => { if (track[key] !== null && !validDateKey(track[key])) errors.push(`${path}.${key} is invalid`); });
    if (![null, "correct", "wrong"].includes(track.lastResult)) errors.push(`${path}.lastResult is invalid`);
    if (!Number.isInteger(track.attemptsOnDate) || track.attemptsOnDate < 0 || track.attemptsOnDate > 3) errors.push(`${path}.attemptsOnDate is invalid`);
    if (!Array.isArray(track.successDatesSinceFailure) || track.successDatesSinceFailure.some(date => !validDateKey(date))) errors.push(`${path}.successDatesSinceFailure is invalid`);
    if (!Array.isArray(track.lapseDates) || track.lapseDates.some(date => !validDateKey(date))) errors.push(`${path}.lapseDates is invalid`);
  }
  function validateEvent(event, index, errors) {
    const path = `reviewEvents.${index}`;
    if (!isObject(event) || !event.id || !event.wordId || !DIRECTIONS.includes(event.direction) || !event.attemptId) errors.push(`${path} identity is invalid`);
    if (!validTimestamp(event?.at) || !validDateKey(event?.studyDate)) errors.push(`${path} date is invalid`);
    if (!["correct", "wrong"].includes(event?.grade) || !["scheduled", "practice", "legacyBaseline"].includes(event?.source)) errors.push(`${path} grade/source is invalid`);
    if (event?.undoneAt !== null && !validTimestamp(event?.undoneAt)) errors.push(`${path}.undoneAt is invalid`);
  }
  function validateBatch(batch, index, errors) {
    const path = `batches.${index}`;
    if (!isObject(batch) || !batch.id || !validTimestamp(batch.createdAt) || !validDateKey(batch.studyDate)) { errors.push(`${path} identity/date is invalid`); return; }
    if (!Number.isInteger(batch.sourceGroup) || batch.sourceGroup < 1) errors.push(`${path}.sourceGroup is invalid`);
    ["sourceLevels", "sourceWordIds", "newWordIds", "order"].forEach(key => { if (!Array.isArray(batch[key])) errors.push(`${path}.${key} must be an array`); });
    if (Array.isArray(batch.newWordIds) && Array.isArray(batch.order)) {
      const expected = [...new Set(batch.newWordIds.map(String))].sort();
      const actual = [...new Set(batch.order.map(String))].sort();
      if (expected.length !== batch.order.length || expected.join("\0") !== actual.join("\0")) errors.push(`${path}.order must be a permutation of newWordIds`);
    }
  }
  function validateUndo(key, snapshot, errors) {
    const path = `dailyUndo.${key}`;
    if (!isObject(snapshot) || !snapshot.wordId || !DIRECTIONS.includes(snapshot.direction) || !validDateKey(snapshot.studyDate)) { errors.push(`${path} identity/date is invalid`); return; }
    if (key !== dailyUndoKey(snapshot.wordId, snapshot.direction, snapshot.studyDate)) errors.push(`${path} key does not match snapshot identity`);
    if (snapshot.track !== null) validateTrack(snapshot.track, `${path}.track`, errors);
    if (snapshot.introducedAt !== null && !validTimestamp(snapshot.introducedAt)) errors.push(`${path}.introducedAt is invalid`);
    if (snapshot.productionTrack !== undefined && snapshot.productionTrack !== null) validateTrack(snapshot.productionTrack, `${path}.productionTrack`, errors);
  }
  function validateSession(session, index, events, errors) {
    const path = `sessions.${index}`;
    if (!isObject(session) || !session.id || !Array.isArray(session.tasks)) { errors.push(`${path} is invalid`); return; }
    if (!["new", "due", "retry", "practice"].includes(session.kind)) errors.push(`${path}.kind is invalid`);
    if (!DIRECTIONS.includes(session.direction) || !validTimestamp(session.createdAt)) errors.push(`${path} direction/date is invalid`);
    if (session.completedAt != null && !validTimestamp(session.completedAt)) errors.push(`${path}.completedAt is invalid`);
    if (!Array.isArray(session.order) || !Array.isArray(session.excludedTaskIds)) errors.push(`${path} order/exclusions are invalid`);
    const pairs = new Set(), attempts = new Set();
    session.tasks.forEach((task, taskIndex) => {
      const item = `${path}.tasks.${taskIndex}`, pair = `${task.wordId}|${task.direction}`;
      if (!task.wordId || !DIRECTIONS.includes(task.direction) || !task.attemptId || !["open", "completed", "excluded"].includes(task.status)) errors.push(`${item} is invalid`);
      if (pairs.has(pair)) errors.push(`${path} has duplicate word/direction tasks`); pairs.add(pair);
      if (attempts.has(task.attemptId)) errors.push(`${path} has duplicate attempt IDs`); attempts.add(task.attemptId);
      const active = events.some(event => event.attemptId === task.attemptId && event.source !== "practice" && !event.undoneAt);
      if (task.status === "completed" && !active) errors.push(`${item} completed status has no active event`);
      if (task.status === "open" && active) errors.push(`${item} open status conflicts with an active event`);
    });
  }
  function validTimestamp(value) { return typeof value === "string" && value.includes("T") && value.endsWith("Z") && Number.isFinite(new Date(value).getTime()); }

  function loadOrMigrate(storage, options) {
    const input = isObject(options) ? options : {}, now = input.now, zone = input.studyTimeZone || input.zone || "UTC";
    const rawV3 = storage.getItem(V3_STORAGE_KEY);
    if (rawV3 !== null) {
      try { const state = JSON.parse(rawV3), result = validateState(state); return result.valid ? { status: "ok", state } : { status: "recovery-required", raw: rawV3, errors: result.errors }; }
      catch (error) { return { status: "recovery-required", raw: rawV3, errors: [error.message] }; }
    }
    const rawV2 = storage.getItem(V2_STORAGE_KEY);
    try {
      const state = rawV2 === null ? createDefaultState({ studyTimeZone: zone, wordIds: input.wordIds || [] }) : migrateV2(JSON.parse(rawV2), now, zone);
      const result = validateState(state); if (!result.valid) return { status: "recovery-required", raw: rawV2, errors: result.errors };
      if (rawV2 !== null) storage.setItem(BACKUP_STORAGE_KEY, rawV2);
      storage.setItem(V3_STORAGE_KEY, JSON.stringify(state));
      return { status: rawV2 === null ? "fresh" : "migrated", state };
    } catch (error) { return { status: "recovery-required", raw: rawV2, state: null, errors: [error.message] }; }
  }

  function saveState(storage, state, expectedRevision) {
    const result = validateState(state); if (!result.valid) return { saved: false, reason: "invalid-state", errors: result.errors };
    const currentRaw = storage.getItem(V3_STORAGE_KEY);
    if (currentRaw !== null && expectedRevision !== undefined) {
      try { const current = JSON.parse(currentRaw); if (current.revision !== expectedRevision) return { saved: false, reason: "stale-revision", currentRevision: current.revision }; }
      catch (_) { return { saved: false, reason: "recovery-required" }; }
    }
    try { storage.setItem(V3_STORAGE_KEY, JSON.stringify(state)); return { saved: true, state }; }
    catch (error) { return { saved: false, reason: "storage-error", error, pendingState: state }; }
  }

  function restoreBackup(storage, now, zone) {
    const raw = storage.getItem(BACKUP_STORAGE_KEY); if (raw === null) return { restored: false, reason: "no-backup" };
    try {
      const parsed = JSON.parse(raw), state = parsed.version === VERSION ? parsed : migrateV2(parsed, now, zone);
      const checked = validateState(state); if (!checked.valid) return { restored: false, reason: "invalid-backup", errors: checked.errors };
      storage.setItem(V3_STORAGE_KEY, JSON.stringify(state)); return { restored: true, state };
    } catch (error) { return { restored: false, reason: "invalid-backup", errors: [error.message] }; }
  }

  return Object.freeze({
    VERSION, V2_STORAGE_KEY, V3_STORAGE_KEY, BACKUP_STORAGE_KEY, INTERVAL_DAYS, DIRECTIONS, POLICIES,
    dateKey, addCalendarDays, createTrack, createDefaultState, activationEligibility, activateEligibleProduction,
    applyScheduledGrade, undoTodayAssessments, deriveDueTasks, migrateV2, importLegacyBaseline,
    validateState, loadOrMigrate, saveState, restoreBackup, dailyUndoKey, isFrequentlyDifficult,
  });
});
