// Read-only timing projection from trusted persisted approval and stage audit.
// No duration is inferred from task count, polling cadence or browser storage.
const STAGES = Object.freeze([
  ["DISCOVERY", "Discovery"],
  ["EMAIL_TRIAGE", "Email inspection"],
  ["SOURCE_PREPARE", "Source preparation"],
  ["SOURCE_RUNNING", "Source enrichment"],
]);
const ACTIVE = new Set(STAGES.map(([key]) => key));
const TERMINAL = new Set(["STOPPED", "PARTIAL", "READY_FOR_REVIEW",
  "NEEDS_REVIEW", "COMPLETED"]);
const MAX_TRANSITIONS = 40;

function milliseconds(value) {
  const time = value instanceof Date ? value.getTime()
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}
function iso(value) { return new Date(value).toISOString(); }

export function projectFullRunTiming(full, transitions, {
  now = new Date(),
} = {}) {
  if (!full || typeof full.status !== "string" ||
      !Array.isArray(transitions) || transitions.length > MAX_TRANSITIONS) {
    throw new TypeError("Bounded persisted full-run timing required");
  }
  const started = milliseconds(full.approvedAt);
  const serverNow = milliseconds(now);
  if (started === null || serverNow === null) {
    throw new TypeError("Valid full-run timing clock required");
  }
  const stages = STAGES.map(([key, label]) => ({
    key, label, startedAt: null, finishedAt: null,
  }));
  // The initial approved charter starts the discovery clock.
  stages[0].startedAt = iso(started);
  let cursor = 0;
  let cursorAt = started;
  const sorted = [...transitions].sort((a, b) =>
    (milliseconds(a.createdAt) ?? -1) - (milliseconds(b.createdAt) ?? -1));
  for (const record of sorted) {
    const at = milliseconds(record?.createdAt);
    const previous = record?.metadata?.priorStage;
    const next = record?.metadata?.stage;
    if (at === null || at < cursorAt || at > serverNow ||
        previous !== STAGES[cursor]?.[0]) continue;
    const nextIndex = STAGES.findIndex(([key]) => key === next);
    if (nextIndex < 0) {
      if (!TERMINAL.has(next)) continue;
      stages[cursor].finishedAt = iso(at);
      cursor = -1;
      break;
    }
    if (nextIndex !== cursor + 1) continue;
    stages[cursor].finishedAt = iso(at);
    stages[nextIndex].startedAt = iso(at);
    cursor = nextIndex;
    cursorAt = at;
  }
  const terminal = TERMINAL.has(full.status);
  let finishedAt = null;
  if (terminal) {
    const terminalStamp = milliseconds(full.updatedAt);
    if (terminalStamp !== null && terminalStamp >= started &&
        terminalStamp <= serverNow) {
      finishedAt = iso(terminalStamp);
      if (cursor >= 0 && stages[cursor].startedAt &&
          !stages[cursor].finishedAt) {
        stages[cursor].finishedAt = finishedAt;
      }
    }
  }
  // If audit history is incomplete, do not pretend that skipped stages ran.
  const currentStage = !terminal && ACTIVE.has(full.status) &&
    stages.find(stage => stage.key === full.status &&
      stage.startedAt !== null && stage.finishedAt === null)
    ? full.status : null;
  return Object.freeze({
    startedAt: iso(started),
    finishedAt,
    currentStage,
    stages: stages.map(stage => Object.freeze(stage)),
  });
}
