// Truthful read-only stage projections from persisted campaign progress.
// Later agent stages are not claimed to be running until their own durable
// telemetry and accepted-contact counters exist.
export function campaignStageTimeline(progress) {
  if (!progress || !progress.tasks ||
      !Number.isInteger(progress.uniqueSourcedCandidates) ||
      !Number.isInteger(progress.targetCount) || progress.targetCount < 1) {
    throw new TypeError("Validated campaign progress required");
  }
  const discovered = progress.uniqueSourcedCandidates;
  const active = progress.tasks.running > 0;
  const failed = progress.needsReconciliation === true ||
    ["PAUSED_REVIEW", "RECOVERY_REQUIRED"].includes(progress.operationalState);
  const terminal = ["COMPLETED", "PARTIAL", "CANCELLED", "FAILED"].includes(
    progress.operationalState);
  const discoveryState = active ? "ACTIVE" :
    failed ? "NEEDS_ATTENTION" :
    terminal ? "FINISHED" :
    progress.tasks.queued > 0 ? "QUEUED" : "AWAITING_STATE";
  return Object.freeze([
    { key: "discovery", title: "Find public expert profiles",
      status: discoveryState,
      detail: `${discovered} cited observations / ${progress.targetCount} discovery target. Not verified contacts.` },
    { key: "sources", title: "Check source and identity",
      status: discovered > 0 ? "REVIEW_AVAILABLE" : "WAITING",
      detail: "Provider citations require independent source and person review." },
    { key: "email", title: "Find named published email",
      status: "MANUAL_ONLY",
      detail: "Individual public profile checks are user-triggered; automatic enrichment not active." },
    { key: "contacts", title: "Accept reviewed contacts",
      status: "MANUAL_ONLY",
      detail: "Only an explicitly confirmed name, category and attributable email may be saved." },
    { key: "outreach", title: "Outreach",
      status: "DISABLED",
      detail: "Sending is not authorized by research, evidence review or contact intake." },
  ]);
}
