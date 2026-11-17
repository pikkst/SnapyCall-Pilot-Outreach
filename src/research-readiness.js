// UI-only interpretation of server-authoritative search prerequisites.
// This function never authorizes a provider call or infers Google account funds.
export function researchReadiness({ aiStatus, keyConfigured, budgetStatus,
  monthlyLimitCents, enforcedForPaidSearch, limitsStatus, pricingStatus,
  selectedProvider, selectedModel, savedProvider, savedModel }) {
  const aiLoaded = aiStatus === "ready";
  const budgetLoaded = budgetStatus === "ready";
  const limitsLoaded = limitsStatus === "ready";
  // Model edits in the browser are only a proposal until saved. Never show
  // the old model's budget as authorization for a new model.
  const modelMatches = !savedProvider || !savedModel ||
    (selectedProvider === savedProvider && selectedModel === savedModel);
  const unavailableModel = pricingStatus === "MODEL_PRICING_UNAVAILABLE";

  const steps = [
    {
      key: "api-key",
      state: !aiLoaded ? "unknown" : keyConfigured ? "ready" : "action",
      title: "Connect your AI provider",
      description: !aiLoaded ? "Checking your saved AI configuration…" :
        keyConfigured ? "Your personal API key is saved." :
          "Choose Gemini, OpenAI or Claude and save your personal API key.",
      action: "settings",
    },
    {
      key: "spending-limit",
      state: !budgetLoaded ? "unknown" :
        monthlyLimitCents === null ? "action" : "ready",
      title: "Set your monthly research budget",
      description: !budgetLoaded ? "Checking the application spending limit…" :
        monthlyLimitCents === null ?
          "Set your monthly USD application limit. Provider account balance is separate." :
          "Your application monthly budget is configured.",
      action: "settings",
    },
    {
      key: "research-access",
      state: !aiLoaded || !budgetLoaded || !limitsLoaded ? "unknown" :
        !keyConfigured || monthlyLimitCents === null ? "pending" :
          enforcedForPaidSearch && modelMatches ? "ready" : "blocked",
      title: "Verify research availability",
      description: !aiLoaded || !budgetLoaded || !limitsLoaded ?
        "Waiting for the server's search readiness and limit status…" :
        !keyConfigured || monthlyLimitCents === null ?
          "Complete the previous steps before checking availability." :
          !modelMatches ? "Save this model selection, then refresh the server's cost authorization." :
          unavailableModel ?
            "This model cannot run paid campaign search yet: its Google Search query count is decided by the provider, so the app cannot enforce a maximum search cost before each request. Your API key and monthly budget are already configured; adding credit or increasing the budget will not remove this safety block. The separate one-time Gemini 3 diagnostic does not enable a campaign." :
          enforcedForPaidSearch ?
            "The server confirms an approved model, enabled research and sufficient application budget." :
            "Search is not available for this model, remaining budget or environment. Adding provider credit alone will not enable it.",
      action: "refresh",
    },
  ];
  return Object.freeze({
    steps,
    ready: steps.every(step => step.state === "ready"),
  });
}
