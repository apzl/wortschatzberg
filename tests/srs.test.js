const test = require("node:test");
const assert = require("node:assert/strict");
const SRS = require("../public/assets/js/srs.js");

const ZONE = "Europe/Berlin";
const at = (day, time = "10:00:00") => `${day}T${time}+02:00`;
const attempt = (wordId, attemptId, kind, direction = "deEn") => ({ wordId: String(wordId), direction, attemptId, kind });

function fresh(ids = ["1"], policy = "staged") {
  return SRS.createDefaultState({ studyTimeZone: ZONE, wordIds: ids, learningPolicy: policy });
}

function grade(state, task, result, now) {
  return SRS.applyScheduledGrade(state, task, result, now, ZONE);
}

test("exports CommonJS API and browser namespace", () => {
  assert.equal(globalThis.WortschatzSRS, SRS);
  assert.equal(typeof SRS.applyScheduledGrade, "function");
});

test("calendar keys honor stored zone and DST while retries use elapsed UTC time", () => {
  assert.equal(SRS.dateKey("2026-09-11T22:30:00Z", ZONE), "2026-09-12");
  assert.equal(SRS.addCalendarDays("2026-03-28", 1), "2026-03-29");
  assert.equal(SRS.addCalendarDays("2026-03-29", 1), "2026-03-30");
  const failed = grade(fresh(), attempt("1", "a1", "new"), "wrong", "2026-03-28T23:58:00Z");
  assert.equal(failed.state.words["1"].tracks.deEn.retryAt, "2026-03-29T00:08:00.000Z");
  assert.equal(failed.state.words["1"].tracks.deEn.dueDate, "2026-03-29");
});

test("30 first assessments introduce every word with 24 due tomorrow and six ready retries", () => {
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
  let state = fresh(ids);
  ids.forEach((id, index) => {
    state = grade(state, attempt(id, `intro-${id}`, "new"), index < 24 ? "correct" : "wrong", at("2026-09-12")).state;
  });
  assert.equal(Object.values(state.words).filter(word => word.introducedAt).length, 30);
  assert.equal(Object.values(state.words).filter(word => word.tracks.deEn.dueDate === "2026-09-13" && !word.tracks.deEn.retryAt).length, 24);
  const ready = SRS.deriveDueTasks(state, at("2026-09-12", "10:11:00"), ZONE).filter(task => task.kind === "retry");
  assert.equal(ready.length, 6);
});

test("interval ladder advances from actual assessment date including overdue work", () => {
  let state = grade(fresh(), attempt("1", "i1", "new"), "correct", at("2026-09-12")).state;
  assert.equal(state.words["1"].tracks.deEn.dueDate, "2026-09-13");
  state = grade(state, attempt("1", "i2", "due"), "correct", at("2026-09-13")).state;
  assert.equal(state.words["1"].tracks.deEn.dueDate, "2026-09-16");
  state = grade(state, attempt("1", "i3", "due"), "correct", at("2026-09-16")).state;
  assert.equal(state.words["1"].tracks.deEn.dueDate, "2026-09-23");

  let overdue = grade(fresh(), attempt("1", "o1", "new"), "correct", at("2026-09-12")).state;
  overdue = grade(overdue, attempt("1", "o2", "due"), "correct", at("2026-09-13")).state;
  overdue = grade(overdue, attempt("1", "o3", "due"), "correct", at("2026-09-20")).state;
  assert.equal(overdue.words["1"].tracks.deEn.dueDate, "2026-09-27");
});

test("ready retry success returns to step zero and third daily failure defers to tomorrow", () => {
  let state = grade(fresh(), attempt("1", "r1", "new"), "wrong", at("2026-09-12", "10:00:00")).state;
  state = grade(state, attempt("1", "r2", "retry"), "correct", at("2026-09-12", "10:10:00")).state;
  assert.equal(state.words["1"].tracks.deEn.step, 0);
  assert.equal(state.words["1"].tracks.deEn.dueDate, "2026-09-13");
  const sameDay = grade(state, attempt("1", "r3", "due"), "correct", at("2026-09-12", "10:20:00"));
  assert.equal(sameDay.scheduled, false);
  assert.equal(sameDay.state.words["1"].tracks.deEn.dueDate, "2026-09-13");

  state = grade(fresh(), attempt("1", "f1", "new"), "wrong", at("2026-09-12", "11:00:00")).state;
  state = grade(state, attempt("1", "f2", "retry"), "wrong", at("2026-09-12", "11:10:00")).state;
  state = grade(state, attempt("1", "f3", "retry"), "wrong", at("2026-09-12", "11:20:00")).state;
  const track = state.words["1"].tracks.deEn;
  assert.equal(track.attemptsOnDate, 3);
  assert.equal(track.step, -1);
  assert.equal(track.retryAt, null);
  assert.equal(track.dueDate, "2026-09-13");
});

test("duplicate attempt IDs cannot double-grade and undo restores the pre-day snapshot", () => {
  const initial = fresh();
  const first = grade(initial, attempt("1", "dup", "new"), "wrong", at("2026-09-12"));
  const duplicate = grade(first.state, attempt("1", "dup", "new"), "correct", at("2026-09-12", "10:01:00"));
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, "duplicate-attempt");
  assert.equal(duplicate.state.revision, first.state.revision);

  const repaired = grade(first.state, attempt("1", "retry", "retry"), "correct", at("2026-09-12", "10:10:00"));
  const undone = SRS.undoTodayAssessments(repaired.state, { wordId: "1", direction: "deEn" }, at("2026-09-12", "10:11:00"), ZONE);
  assert.equal(undone.applied, true);
  assert.equal(undone.state.words["1"].tracks.deEn, null);
  assert.equal(undone.state.words["1"].introducedAt, null);
  assert.equal(undone.undoneEvents.length, 2);
  assert.ok(undone.state.reviewEvents.filter(event => event.attemptId === "dup" || event.attemptId === "retry").every(event => event.undoneAt));
});

test("staged production activates after successes on two dates and schedules independently", () => {
  let state = grade(fresh(), attempt("1", "d1", "new"), "correct", at("2026-09-12")).state;
  const sameDate = grade(state, attempt("1", "d-repeat", "due"), "correct", at("2026-09-12", "10:05:00")).state;
  assert.equal(sameDate.words["1"].tracks.enDe, null);
  state = grade(state, attempt("1", "d2", "due"), "correct", at("2026-09-13")).state;
  assert.equal(SRS.activationEligibility(state, "1"), false, "already activated is not newly eligible");
  assert.equal(state.words["1"].tracks.enDe.dueDate, "2026-09-14");
  const recognitionBefore = structuredClone(state.words["1"].tracks.deEn);
  state = grade(state, attempt("1", "p1", "due", "enDe"), "wrong", at("2026-09-14")).state;
  assert.deepEqual(state.words["1"].tracks.deEn, recognitionBefore);
  assert.equal(state.words["1"].tracks.enDe.lastResult, "wrong");
});

test("policy-switch activation helper enrolls eligible production exactly once", () => {
  let state = fresh();
  state.words["1"].introducedAt = "2026-09-12T08:00:00.000Z";
  state.words["1"].tracks.deEn = SRS.createTrack("2026-09-20", { status: "review", step: 1, successDatesSinceFailure: ["2026-09-12", "2026-09-13"] });
  const first = SRS.activateEligibleProduction(state, at("2026-09-14"), ZONE);
  assert.deepEqual(first.activatedWordIds, ["1"]);
  assert.equal(first.state.words["1"].tracks.enDe.dueDate, "2026-09-15");
  const second = SRS.activateEligibleProduction(first.state, at("2026-09-14"), ZONE);
  assert.deepEqual(second.activatedWordIds, []);
  assert.equal(second.state, first.state);
});

test("due derivation ignores practice learned filtering, respects direction isolation, and explains order", () => {
  let state = fresh(["2", "10", "3"]);
  state.words["2"].learned = true;
  state.words["2"].tracks.deEn = SRS.createTrack("2026-09-10", { status: "review", step: 1, lastResult: "correct" });
  state.words["10"].tracks.deEn = SRS.createTrack("2026-09-12", { status: "review", step: 0, lastResult: "wrong" });
  state.words["3"].tracks.enDe = SRS.createTrack("2026-09-12");
  const all = SRS.deriveDueTasks(state, at("2026-09-12"), ZONE);
  assert.deepEqual(all.map(task => task.wordId), ["2", "10", "3"]);
  assert.equal(all[0].reason, "2 Tage überfällig");
  assert.ok(all.some(task => task.wordId === "2"), "green words remain due");
  assert.deepEqual(SRS.deriveDueTasks(state, at("2026-09-12"), ZONE, { directions: ["enDe"] }).map(task => task.wordId), ["3"]);
});

test("three lapse dates in the trailing 14 dates mark a track frequently difficult", () => {
  const track = SRS.createTrack("2026-09-12", { lapseDates: ["2026-08-01", "2026-09-01", "2026-09-05", "2026-09-12"] });
  assert.equal(SRS.isFrequentlyDifficult(track, "2026-09-12"), true);
  assert.equal(SRS.isFrequentlyDifficult(track, "2026-09-20"), false);
});

test("v2 migration preserves library/practice data without inventing schedules", () => {
  const v2 = {
    version: 2, activeDay: 7, groupStart: 2, groupEnd: 9, level: "B1", order: ["9", "1"], palette: "purple",
    words: { "1": { target: true, learned: true, lastResult: "correct", note: "behalten" }, "gone": { target: true, learned: false, lastResult: "wrong", note: "orphan" } },
    lastTest: { correct: 2, total: 3 },
  };
  const state = SRS.migrateV2(v2, at("2026-09-12"), ZONE);
  assert.equal(state.version, 3);
  assert.deepEqual(state.library.order, ["9", "1"]);
  assert.equal(state.library.palette, "purple");
  assert.equal(state.words["1"].note, "behalten");
  assert.equal(state.words["1"].tracks.deEn, null);
  assert.equal(state.words.gone.target, true, "unavailable IDs remain preserved");
  assert.deepEqual(state.lastTest, v2.lastTest);
  assert.deepEqual(state.migration.legacyBaseline.eligibleWordIds.sort(), ["1", "gone"]);
  assert.equal(SRS.validateState(state).valid, true);
});

test("legacy baseline enrollment is explicit and creates no invented events", () => {
  const migrated = SRS.migrateV2({ version: 2, words: { "1": { learned: true, note: "x" }, "2": { learned: false } } }, at("2026-09-12"), ZONE);
  const imported = SRS.importLegacyBaseline(migrated, at("2026-09-12"), ZONE);
  assert.equal(imported.count, 1);
  assert.equal(imported.state.words["1"].tracks.deEn.dueDate, "2026-09-12");
  assert.equal(imported.state.reviewEvents.length, 0);
  assert.equal(imported.state.words["2"].tracks.deEn, null);
});

test("validation catches invalid tracks and completed session tasks without active events", () => {
  const state = fresh();
  state.words["1"].tracks.deEn = SRS.createTrack("2026-09-12");
  state.words["1"].tracks.deEn.step = 99;
  state.sessions.push({ id: "s", tasks: [{ wordId: "1", direction: "deEn", attemptId: "a", status: "completed" }] });
  const checked = SRS.validateState(state);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.some(error => error.includes("step")));
  assert.ok(checked.errors.some(error => error.includes("no active event")));
});

test("scheduled grading atomically validates a frozen batch, session task, and event", () => {
  let state = fresh();
  state.batches.push({ id: "b1", createdAt: "2026-09-12T08:00:00.000Z", studyDate: "2026-09-12", sourceGroup: 1, sourceLevels: ["A1"], sourceWordIds: ["1"], newWordIds: ["1"], order: ["1"] });
  state.sessions.push({ id: "s1", createdAt: "2026-09-12T08:00:00.000Z", kind: "new", direction: "deEn", batchId: "b1", tasks: [{ wordId: "1", direction: "deEn", attemptId: "atomic", status: "open" }], selectedTaskId: "atomic", order: ["atomic"], excludedTaskIds: [], completedAt: null });
  state = grade(state, { wordId: "1", direction: "deEn", sessionId: "s1", attemptId: "atomic" }, "correct", at("2026-09-12")).state;
  assert.equal(state.sessions[0].tasks[0].status, "completed");
  assert.equal(state.sessions[0].tasks[0].eventId, state.reviewEvents[0].id);
  assert.equal(SRS.validateState(state).valid, true);
});

test("storage migration is idempotent, preserves raw v2, and invalid v3 requires recovery", () => {
  class MemoryStorage {
    constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
    setItem(key, value) { this.map.set(key, String(value)); }
  }
  const rawV2 = JSON.stringify({ version: 2, words: { "1": { note: "safe" } } });
  const storage = new MemoryStorage({ [SRS.V2_STORAGE_KEY]: rawV2 });
  const first = SRS.loadOrMigrate(storage, { now: at("2026-09-12"), studyTimeZone: ZONE });
  assert.equal(first.status, "migrated");
  assert.equal(storage.getItem(SRS.V2_STORAGE_KEY), rawV2);
  assert.equal(storage.getItem(SRS.BACKUP_STORAGE_KEY), rawV2);
  assert.equal(SRS.loadOrMigrate(storage, { now: at("2026-09-13"), studyTimeZone: ZONE }).status, "ok");
  storage.setItem(SRS.V3_STORAGE_KEY, "{broken");
  const recovery = SRS.loadOrMigrate(storage, { now: at("2026-09-13"), studyTimeZone: ZONE });
  assert.equal(recovery.status, "recovery-required");
  assert.equal(storage.getItem(SRS.V2_STORAGE_KEY), rawV2);
});

test("revision-aware save rejects stale tabs and retains pending state on storage failure", () => {
  const current = fresh(); current.revision = 3;
  const storage = { value: JSON.stringify(current), getItem() { return this.value; }, setItem(_, value) { this.value = value; } };
  const candidate = structuredClone(current); candidate.revision = 4;
  assert.equal(SRS.saveState(storage, candidate, 2).reason, "stale-revision");
  assert.equal(SRS.saveState(storage, candidate, 3).saved, true);
  const failing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const result = SRS.saveState(failing, candidate);
  assert.equal(result.reason, "storage-error");
  assert.equal(result.pendingState, candidate);
});
