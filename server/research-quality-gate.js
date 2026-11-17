// The quality streak is computed from durable task outcomes, not a browser
// counter. Only completed tasks count. A cited candidate is still UNVERIFIED;
// passing this gate never authorizes accepting a person or email.
export const MAX_CONSECUTIVE_QUALITY_FAILURES = 3;

export function consecutiveQualityFailures(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("Task outcomes are required");
  // A legacy read-only projection may omit taskIndex; only trustworthy
  // indexed task outcomes can establish a consecutive streak.
  const ordered = tasks.filter(task => Number.isInteger(task?.taskIndex))
    .sort((a, b) => b.taskIndex - a.taskIndex);
  // The future queued tasks are not quality outcomes. Anchor at the latest
  // completed task, then require contiguous task indexes to prevent skipping
  // over a PAUSED, CANCELLED or unsettled paid task.
  const latest = ordered.find(task => task.status === "COMPLETED");
  if (!latest) return 0;
  let expectedIndex = latest.taskIndex;
  let failures = 0;
  for (const task of ordered.filter(task => task.taskIndex <= latest.taskIndex)) {
    if (!Number.isInteger(task.taskIndex) || task.taskIndex < 0 ||
        !Number.isInteger(task.observedCount) || task.observedCount < 0 ||
        typeof task.status !== "string") {
      throw new TypeError("Invalid persisted task quality outcome");
    }
    // Missing/in-flight/paused/cancelled task is NOT a successful validation.
    // It interrupts an unsafe assumption that three completed results were
    // consecutive; upstream reconciliation must resolve such tasks first.
    if (task.taskIndex !== expectedIndex || task.status !== "COMPLETED") break;
    if (task.observedCount > 0) break;
    failures++;
    expectedIndex--;
    if (failures === MAX_CONSECUTIVE_QUALITY_FAILURES) break;
  }
  return failures;
}

export function shouldStopForQuality(tasks) {
  return consecutiveQualityFailures(tasks) >= MAX_CONSECUTIVE_QUALITY_FAILURES;
}
