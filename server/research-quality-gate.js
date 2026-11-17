// The quality streak is computed from durable task outcomes, not a browser
// counter. Only completed tasks count. A cited candidate is still UNVERIFIED;
// passing this gate never authorizes accepting a person or email.
export const MAX_CONSECUTIVE_QUALITY_FAILURES = 3;

export function consecutiveQualityFailures(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("Task outcomes are required");
  const ordered = [...tasks].sort((a, b) => b.taskIndex - a.taskIndex);
  let failures = 0;
  for (const task of ordered) {
    if (!Number.isInteger(task.taskIndex) || task.taskIndex < 0 ||
        !Number.isInteger(task.observedCount) || task.observedCount < 0 ||
        typeof task.status !== "string") {
      throw new TypeError("Invalid persisted task quality outcome");
    }
    // Missing/in-flight/paused/cancelled task is NOT a successful validation.
    // It interrupts an unsafe assumption that three completed results were
    // consecutive; upstream reconciliation must resolve such tasks first.
    if (task.status !== "COMPLETED") break;
    if (task.observedCount > 0) break;
    failures++;
    if (failures === MAX_CONSECUTIVE_QUALITY_FAILURES) break;
  }
  return failures;
}

export function shouldStopForQuality(tasks) {
  return consecutiveQualityFailures(tasks) >= MAX_CONSECUTIVE_QUALITY_FAILURES;
}
