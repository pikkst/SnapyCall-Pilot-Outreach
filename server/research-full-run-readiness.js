// Canonical capability gate: approval and the server worker must agree.
// Only names of missing public workflow stages are exposed, never secrets.
export const FULL_RUN_FLAGS = Object.freeze({
  AI_FULL_RUN_ENABLED: "full_run",
  AI_PERSON_SOURCE_APPROVAL_ENABLED: "person_source_approval",
  AI_PERSON_SOURCE_EXECUTOR_ENABLED: "person_source_executor",
  AI_EMAIL_TRIAGE_ENABLED: "email_triage",
  AI_AGENT_AUTORUN_ENABLED: "discovery_autorun",
  AI_AGENT_RESEARCH_ENABLED: "discovery_research",
  AI_AGENT_EXECUTOR_ENABLED: "discovery_executor",
});

export function fullRunReadiness(env) {
  const missingStages = Object.entries(FULL_RUN_FLAGS)
    .filter(([name]) => env?.[name] !== "true")
    .map(([, stage]) => stage);
  return Object.freeze({
    enabled: missingStages.length === 0,
    missingStages: Object.freeze(missingStages),
  });
}
