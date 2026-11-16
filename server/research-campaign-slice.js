// Explicit, bounded multi-task slice built from the existing one-task worker.
// No background schedule and no optimistic retry after an uncertain paid call.
const MAX_TASKS_PER_SLICE = 3;

export function validateResearchSliceInput(value) {
  if (value == null || typeof value !== "object" ||
      Array.isArray(value) || Object.keys(value).some(key => key !== "maxTasks")) {
    throw new TypeError("Invalid campaign execution request");
  }
  const maxTasks = value.maxTasks ?? 1;
  if (!Number.isInteger(maxTasks) || maxTasks < 1 ||
      maxTasks > MAX_TASKS_PER_SLICE) {
    throw new TypeError("Campaign slice must request 1-3 tasks");
  }
  return Object.freeze({ maxTasks });
}

// Always stop at the first non-completed attempt. A failed provider call may
// already be chargeable; repeating it automatically would be unsafe.
// runTask MUST be the existing runOneCampaignTask so that each iteration
// receives independent membership, budget, quota, lease and evidence checks.
export async function runBoundedCampaignSlice(input, { runTask } = {}) {
  const { maxTasks } = validateResearchSliceInput(input);
  if (typeof runTask !== "function") {
    throw new TypeError("Trusted research campaign worker required");
  }
  const results = [];
  for (let index = 0; index < maxTasks; index++) {
    let result;
    try {
      result = await runTask();
    } catch {
      // A later call can fail preflight after earlier tasks committed. Never
      // lose that partial progress, retry the call or leak provider errors.
      return Object.freeze({
        status: "REVIEW_REQUIRED",
        attemptedTasks: results.length,
        completedTasks: results.length,
        taskResults: Object.freeze(results),
        code: "RESEARCH_SLICE_HALTED",
        attempted: false,
        sendingEnabled: false,
      });
    }
    if (!result || typeof result.status !== "string") {
      throw new TypeError("Invalid campaign worker outcome");
    }
    if (result.status === "COMPLETED") {
      results.push(Object.freeze({
        status: "COMPLETED",
        taskId: result.taskId,
        uniqueAdded: result.uniqueAdded,
        duplicates: result.duplicates,
      }));
      continue;
    }
    // NO_READY_TASK is not evidence of a completed campaign: it can also
    // mean quota/lease/retry delay, exhausted tasks or target reached.
    // Never retry or claim success from this response alone.
    return Object.freeze({
      status: result.status === "NO_READY_TASK" ?
        "NO_READY_TASK" : "REVIEW_REQUIRED",
      attemptedTasks: results.length + (result.attempted ? 1 : 0),
      completedTasks: results.length,
      taskResults: Object.freeze(results),
      code: result.code ?? (result.status === "NO_READY_TASK" ?
        "RESEARCH_NO_READY_TASK" : "RESEARCH_TASK_REQUIRES_REVIEW"),
      attempted: result.attempted === true,
      sendingEnabled: false,
    });
  }
  return Object.freeze({
    status: "SLICE_COMPLETED", completedTasks: results.length,
    attemptedTasks: results.length, taskResults: Object.freeze(results),
    sendingEnabled: false,
  });
}
