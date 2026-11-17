import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { manualIndependentResearch } from "../src/manual-research.js";
import { reviewedCandidateKey, resolvedReviewedSource, reviewedSeedBatch, selectedDiscoverySeedBatch } from "../src/research-review-batch.js";
import { researchReadiness } from "../src/research-readiness.js";
import { runApprovedCampaignBatch } from "../src/campaign-batch.js";
import { campaignStageTimeline } from "../src/campaign-stage-timeline.js";
import { describeCampaignBudget } from "../src/campaign-budget-status.js";
import { singleAuthorizedWorkspaceId } from "../src/partner-workspace-navigation.js";

type CampaignSummary = { id: string; query: string; targetCount: number; status: string; plannedTasks: number; uniqueSourcedCandidates: number; createdAt: string; providerCallsAuthorized: false };
type CampaignProgress = {
  id: string; status: string; operationalState: string; action: string;
  targetCount: number; uniqueSourcedCandidates: number;
  rawCandidateObservations: number; duplicateObservations: number;
  plannedTasks: number; expiredLeases: number; needsReconciliation: boolean;
  pausedTaskReview: Array<{taskIndex: number;lastErrorCode: "BILLING_UNCERTAIN"}>;
  tasks: { queued: number; running: number; completed: number;
    paused: number; failed: number; cancelled: number };
  contactVerification: "NOT_PERFORMED"; sendingEnabled: false;
};
type CampaignObservation = {
  id: string; name: string; category: string; citationUrl: string;
  rationale: string; status: string; observedAt: string; candidateId?: string | null;
  emailTriageStatus?: string; emailTriageCode?: string | null;
  emailTriageEmail?: string | null; emailTriageAt?: string | null;
};
type CampaignEmailTriageState = {
  status: "IDLE" | "RUNNING" | "PAUSED" | "COMPLETED";
  maxPages: number; expiresAt: string | null;
  remaining: number; checking: number; reviewRequired: number;
  noEmail: number; blocked: number; uncertain: number;
  contactsCreated: 0; providerCalls: 0; sendingEnabled: false;
  enabled: boolean;
};
type CampaignObservationsPage = {
  observations: CampaignObservation[]; nextCursor: string | null;
  verifiedContacts: number; sendingEnabled: false;
};
type CampaignEmailInspection = {
  code: string; name?: string; category?: string; observedEmail?: string;
  sourceUrl?: string; reviewRequired?: boolean; evidenceDigest?: string;
  contactCreated: false; emailChecked: boolean; sendingEnabled: false;
};
type ManualCampaignSource = {
  id: string; normalizedUrl: string; sourceKind: string;
  status: string; createdAt: string;
};
type CampaignSourcesResponse = {
  sources: ManualCampaignSource[]; inspected: false; providerCallsAuthorized: false;
};
type ApprovedCampaignRun = {
  id: string; status: string; maxTasks: number; startedTasks: number;
  maxWorstCaseCents: number; committedWorstCaseCents: number;
  lastCode: string | null; expiresAt: string; sendingEnabled: false;
};
type CampaignRunApprovalState = {
  run: ApprovedCampaignRun | null; autonomousRunEnabled: boolean;
  priceEnvelope: null | { provider: string; model: string;
    worstCasePerCallCents: number; priceVersion: string };
  sendingEnabled: false;
};
type PartnerTab = "dashboard" | "candidates" | "discovery" | "drafts" | "profile" | "settings";
type PartnerSession = { authenticated: boolean; conflict?: boolean; userId?: string; displayName?: string | null; partners?: Array<{ id: string; name: string; role: string }> };
type GoogleConnection = { partnerId: string; scope: string; updatedAt: string };
type PartnerInvitation = { id: string; workspaceId: string; workspace: string;
  email: string; status: string; sentAt: string | null; acceptedAt: string | null;
  leaseUntil: string | null; errorCode: string | null; attempt: number };
type ConnectionStatus = "loading" | "ready" | "unavailable";
type ConnectionResponse = { connections: GoogleConnection[]; available: boolean };
type GmailStatus = { connected: boolean; available: boolean; email: string; sendingEnabled: false };
type PartnerSelfProfile = {
  displayName: string; email: string; jobTitle: string; organizationName: string;
  businessPhone: string; publicWebsite: string; emailSignature: string;
};
type Candidate = {
  id: string; name: string; email: string | null; category: string;
  region: string | null; onlineEnglish: boolean; status: string;
  sourceUrl: string | null; researchCitationUrl?: string | null; discoveryKey: string | null; expertProfileUrl: string | null;
  profileReviewed: boolean; suppressed: boolean;
  score: { score: number | null; eligible: boolean; stage: string };
  qualification: { stage: string; qualified: boolean; score: null; blockers: string[] };
  outreach: { stage: string; canDraft: boolean; canSend: false; blockers: string[] };
  contactVerification?: {
    personEmail: "REVIEWED" | "REVIEW_REQUIRED" | "UNVERIFIED";
    mailbox: "VALID" | "INVALID" | "RISKY" | "UNKNOWN";
    usableAsContact: boolean; draftEligible: boolean;
    onboardingEligible: false; sendingEnabled: false;
  };
};
type DirectEmailEvidenceResponse = {
  candidateId: string; personEmailLinked: boolean;
  usableAsContact: false; onboardingEligible: false; sendingEnabled: false;
  observation: null | {
    sourceUrl: string; observedEmail: string; evidenceDigest: string;
    status: "REVIEW_REQUIRED" | "PERSON_EMAIL_REVIEWED";
    reviewRequired: boolean; personEmailLinked: boolean; inspectedAt: string;
  };
};
type Draft = { id: string; subject: string; body: string; provider: string; model: string; candidate: { name: string } };
type ResearchPreview = {
  workspaceId: string; provider: "anthropic" | "openai" | "gemini"; model: string;
  quota: { dayUtc: string; remaining: { userWorkspace: number; workspace: number } };
  candidates: Array<{
    name: string; category: string; sourceUrl: string; rationale: string;
    email: null; contactReviewed: false; status: "REVIEW_PENDING";
  }>;
  sources: Array<{ url: string; title: string }>;
  warnings: string[]; usage: { inputTokens: number | null;
    outputTokens: number | null; searchRequests: number | null };
  imported: false; reviewRequired: true; sendingEnabled: false;
  publicBusinessContacts?: Array<{ type: "PUBLIC_BUSINESS_INBOX";
    observedEmail: string; sourceUrl: string; provenance: "SERVER_INSPECTED_PAGE";
    status: "REVIEW_REQUIRED"; identityVerified: false; contactPermission: false }>;
  pagesInspected?: number; contactReviewRequired?: true;
  contactAssociations?: Array<{ sourceUrl: string; observedEmail: string;
    candidateNames: string[]; relationship: "SAME_CITED_PAGE_UNVERIFIED" | "SHARED_SOURCE_AMBIGUOUS";
    organizationVerified: false; identityVerified: false; contactPermission: false;
    reviewRequired: true }>;
  identityCollisions?: Array<{ name: string; sourceUrls: string[];
    status: "IDENTITY_REVIEW_REQUIRED"; automaticMergeAllowed: false }>;
  profileObservations?: Array<{ name: string; sourceUrl: string;
    observation: "EXACT_NAME_ON_INSPECTED_SOURCE" | "NAME_NOT_OBSERVED";
    profileIdentityVerified: false; organizationAffiliationVerified: false;
    contactOwnershipVerified: false; reviewRequired: true }>;
  evidenceReviewOrder?: Array<{ name: string; sourceUrl: string;
    evidenceLevel: "PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX" |
      "PUBLIC_SOURCE_INSPECTED_NO_CONTACT" | "PROVIDER_CITATION_ONLY";
    manualReviewRequired: true; individualEmailVerified: false }>;
};
type AiSetting = { provider: string; model: string; keyConfigured: boolean; fingerprint?: string };
type ResearchLimits = { dailyLimit: number; maxCandidates: number; maxConcurrent: number };
type ResearchReconciliationOverview = {
  checkedAt: string; staleAfterMinutes: number; pendingReservations: number;
  pendingCents: number; staleReservations: number; staleCents: number;
  oldestStaleAt: string | null; needsReview: boolean;
  currency: "USD"; billingSource: "application-estimate";
  action: "manual-review-only";
};

type ResearchBudget = { monthlyLimitCents: number | null; currency: "USD";
  enforcedForPaidSearch: boolean; ledger?: {
    monthUtc: string; reservedCents: number; settledCents: number;
    pendingReservations: number; availableCents: number | null;
    billingSource: "application-estimate";
  }; reconciliation?: { staleAfterMinutes: number; staleReservations: number;
    oldestPendingAt: string | null; needsReview: boolean } };
type DuplicateHint = { id: string; reasons: string[] };
type Evidence = { id: string; kind: string; sourceUrl: string; note: string | null; capturedAt: string };
type FeedEntry = { discoveryKey: string; name: string; headline: string; sourceUrl: string; feedUrl: string; proof: string };

const defaultAiModels: Record<string, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-6",
};

const categories = [
  ["AI_AUTOMATION", "AI automation / no-code"],
  ["COACHING", "Coaching"],
  ["MARKETING_GROWTH", "Marketing & growth"],
  ["BUSINESS_STRATEGY", "Business strategy"],
];
const stageNames: Record<string, string> = {
  DISCOVERED: "Found — check expertise", EVIDENCE_PENDING: "Evidence needed",
  QUALIFIED: "Qualified — find contact", CONTACT_REVIEW: "Contact review needed",
  DRAFT_READY: "Ready for AI draft", SUPPRESSED: "Suppressed", REJECTED: "Rejected",
};
const reasonNames: Record<string, string> = {
  english_online_requirement_unconfirmed: "Confirm English online consultations",
  expert_profile_review_pending: "Review a separate expert profile",
  email_missing: "Add a verified contact channel", legal_basis_missing: "Review legal basis",
  contact_review_pending: "Review contact details",
  person_email_link_unverified: "Verify the exact person-to-email link",
  mailbox_deliverability_unconfirmed: "Validate this specific mailbox",
  suppressed: "Contact is suppressed",
  candidate_rejected: "Candidate was rejected",
};
const regions = [
  ["US", "United States"],
  ["UK_IRELAND", "United Kingdom / Ireland"],
  ["OTHER_ENGLISH_SPEAKING", "Other English-speaking regions"],
];

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const info = typeof result === "object" && result !== null ? result as { error?: string; code?: string; stage?: string } : null;
    const message = info?.code && info.stage
      ? "Discovery source error: " + info.code + " (" + info.stage + "). No candidates were imported."
      : (info?.error ?? "Request failed");
    throw new Error(message);
  }
  return result as T;
}

function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [sessionConflict, setSessionConflict] = useState(false);
  const [operatorResearch, setOperatorResearch] = useState<ResearchReconciliationOverview | null>(null);
  const [operatorResearchStatus, setOperatorResearchStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [partnerTab, setPartnerTab] = useState<PartnerTab>("dashboard");
  const [partnerSession, setPartnerSession] = useState<PartnerSession | null>(null);
  const [myProfile, setMyProfile] = useState<PartnerSelfProfile | null>(null);
  const [profileState, setProfileState] = useState<"loading" | "ready" | "error">("loading");
  const [profileSaving, setProfileSaving] = useState(false);
  const [googleConnections, setGoogleConnections] = useState<GoogleConnection[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("loading");
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [gmailStatusError, setGmailStatusError] = useState(false);
  const [personalAi, setPersonalAi] = useState<AiSetting>({
    provider: "gemini", model: "gemini-2.5-flash", keyConfigured: false,
  });
  const [personalApiKey, setPersonalApiKey] = useState("");
  const [researchLimits, setResearchLimits] = useState<ResearchLimits>({ dailyLimit: 2, maxCandidates: 10, maxConcurrent: 1 });
  const [researchLimitsStatus, setResearchLimitsStatus] =
    useState<"loading" | "ready" | "error">("loading");
  const [researchBudget, setResearchBudget] = useState<ResearchBudget>({
    monthlyLimitCents: null, currency: "USD", enforcedForPaidSearch: false,
  });
  const [budgetStatus, setBudgetStatus] = useState<"loading" | "ready" | "error">("loading");
  const [personalAiStatus, setPersonalAiStatus] = useState<"loading" | "ready" | "error">("loading");

  const workspaceRequest = useRef(0);
  const campaignProgressRequest = useRef(0);
  const partnerEvidenceRequest = useRef(0);
  const partnerReviewRequest = useRef(0);
  const personEmailRequest = useRef(0);
  const [personEmailCandidateId, setPersonEmailCandidateId] = useState<string | null>(null);
  const [personEmailEvidence, setPersonEmailEvidence] =
    useState<DirectEmailEvidenceResponse | null>(null);
  const [personEmailBusy, setPersonEmailBusy] = useState(false);
  const [personEmailConfirmed, setPersonEmailConfirmed] = useState(false);
  const [partnerReviewSaving, setPartnerReviewSaving] = useState(false);
  const [partnerEvidenceId, setPartnerEvidenceId] = useState<string | null>(null);
  const [partnerEvidenceRows, setPartnerEvidenceRows] = useState<Evidence[]>([]);
  const [partnerEvidenceState, setPartnerEvidenceState] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [partnerEvidenceUrl, setPartnerEvidenceUrl] = useState("");
  const [partnerEvidenceKind, setPartnerEvidenceKind] = useState("PROFILE");
  const [partnerEvidenceNote, setPartnerEvidenceNote] = useState("");
  const [partnerEvidenceSaving, setPartnerEvidenceSaving] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceCandidates, setWorkspaceCandidates] = useState<Candidate[]>([]);
  const [workspaceDrafts, setWorkspaceDrafts] = useState<Draft[]>([]);
  const [workspaceCampaigns, setWorkspaceCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignListStatus, setCampaignListStatus] = useState<"idle" | "ready" | "error">("idle");
  const [campaignTestQuery, setCampaignTestQuery] =
    useState("Find English-speaking AI automation consultants who offer online consulting, with public professional profiles");
  const [campaignTestBusy, setCampaignTestBusy] = useState(false);
  const [campaignTestNotice, setCampaignTestNotice] = useState("");
  const [campaignPaidConfirmed, setCampaignPaidConfirmed] = useState(false);
  const [campaignBatchCompleted, setCampaignBatchCompleted] = useState(0);
  const campaignBatchProgressRef = useRef(0);
  const batchInFlight = useRef(false);
  const batchStopRequested = useRef(false);
  const [skipChargeConfirmed, setSkipChargeConfirmed] = useState(false);
  const campaignCreateIdempotency = useRef<string | null>(null);
  const [campaignProgressId, setCampaignProgressId] = useState<string | null>(null);
  const [campaignProgress, setCampaignProgress] = useState<CampaignProgress | null>(null);
  const [campaignEmailTriage, setCampaignEmailTriage] =
    useState<CampaignEmailTriageState | null>(null);
  const [campaignTriageBusy, setCampaignTriageBusy] = useState(false);
  const [campaignTriageConfirmed, setCampaignTriageConfirmed] = useState(false);
  const [campaignTriageNotice, setCampaignTriageNotice] = useState("");

  const [campaignRunApproval, setCampaignRunApproval] =
    useState<CampaignRunApprovalState | null>(null);
  const [campaignRunApprovalBusy, setCampaignRunApprovalBusy] = useState(false);
  const [campaignRunApprovalNotice, setCampaignRunApprovalNotice] = useState("");
  const [campaignMaxTasks, setCampaignMaxTasks] = useState(10);
  const [campaignNoReplayConfirmed, setCampaignNoReplayConfirmed] = useState(false);

  const [campaignProgressLastSeen, setCampaignProgressLastSeen] = useState<number | null>(null);
  const [campaignProgressLiveWarning, setCampaignProgressLiveWarning] = useState(false);
  const [manualSourceDraft, setManualSourceDraft] = useState("");
  const [manualSources, setManualSources] = useState<ManualCampaignSource[]>([]);
  const [manualSourceStatus, setManualSourceStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [manualSourceNotice, setManualSourceNotice] = useState("");
  const [manualSourceBusy, setManualSourceBusy] = useState(false);
  const manualSourceRequest = useRef(0);
  const [campaignObservations, setCampaignObservations] = useState<CampaignObservation[]>([]);
  const [campaignObservationsCursor, setCampaignObservationsCursor] = useState<string | null>(null);
  const [campaignObservationsStatus, setCampaignObservationsStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const campaignObservationsRequest = useRef(0);
  const [campaignEmailInspections, setCampaignEmailInspections] =
    useState<Record<string, CampaignEmailInspection>>({});
  const [campaignEmailInspectionBusy, setCampaignEmailInspectionBusy] =
    useState<string | null>(null);
  const [campaignEmailInspectionError, setCampaignEmailInspectionError] =
    useState<Record<string, string>>({});
  const [campaignContactConfirm, setCampaignContactConfirm] =
    useState<Record<string, boolean>>({});
  const [campaignContactSaveBusy, setCampaignContactSaveBusy] =
    useState<string | null>(null);
  const [campaignContactSaveNotice, setCampaignContactSaveNotice] =
    useState<Record<string, string>>({});
  const [campaignProgressStatus, setCampaignProgressStatus] =
    useState<"idle" | "loading" | "ready" | "error">("idle");
  const [workspaceDataStatus, setWorkspaceDataStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [researchQuery, setResearchQuery] = useState("Find experienced English-speaking AI automation consultants offering online consultations");
  const [seedName, setSeedName] = useState("");
  const [seedCategory, setSeedCategory] = useState("COACHING");
  const [seedUrl, setSeedUrl] = useState("");
  const [seedSaving, setSeedSaving] = useState(false);
  const [researchResult, setResearchResult] = useState<ResearchPreview | null>(null);
  const [researchStatus, setResearchStatus] = useState<"idle" | "loading" | "error">("idle");
  const [researchError, setResearchError] = useState("");
  // User-confirmed inspection is required before reusing the manual review
  // endpoint; an AI citation alone is not a verified source or contact.
  const [reviewedResearchSources, setReviewedResearchSources] = useState<string[]>([]);
  const [selectedResearchCandidates, setSelectedResearchCandidates] = useState<string[]>([]);
  const [reviewedResearchUrls, setReviewedResearchUrls] = useState<Record<string, string>>({});
  const [savingResearchCandidate, setSavingResearchCandidate] = useState<string | null>(null);
  const researchSaveInFlight = useRef(false);
  const [savedResearchCandidates, setSavedResearchCandidates] = useState<string[]>([]);
  const [partnerName, setPartnerName] = useState("");
  const [partnerEmail, setPartnerEmail] = useState("");
  const [partnerTarget, setPartnerTarget] = useState("new");
  const [partnerWorkspaces, setPartnerWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [partnerInvitations, setPartnerInvitations] = useState<PartnerInvitation[]>([]);
  const [inviteEmailConfigured, setInviteEmailConfigured] = useState(false);
  const [inviteReceipt, setInviteReceipt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"candidates" | "discovery" | "drafts" | "settings">("candidates");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [setting, setSetting] = useState<AiSetting>({ provider: "gemini", model: "gemini-2.5-flash", keyConfigured: false });
  const [apiKey, setApiKey] = useState("");
  const [feeds, setFeeds] = useState<string[]>([]);
  const [selectedFeed, setSelectedFeed] = useState("");
  const [discovered, setDiscovered] = useState<FeedEntry[]>([]);
  const [discoveryCategory, setDiscoveryCategory] = useState("AI_AUTOMATION");
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [duplicateHints, setDuplicateHints] = useState<DuplicateHint[]>([]);
  const [duplicateScanIncomplete, setDuplicateScanIncomplete] = useState(false);
  const [evidenceKind, setEvidenceKind] = useState("ARTICLE");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [reviewProfileUrl, setReviewProfileUrl] = useState("");
  const [reviewRegion, setReviewRegion] = useState("");
  const [reviewEnglish, setReviewEnglish] = useState(false);
  const [candidate, setCandidate] = useState({
    name: "", email: "", category: "AI_AUTOMATION", region: "US", sourceUrl: "",
    onlineEnglish: false, legalBasis: "", contactReviewed: false,
  });

  async function loadResearchReconciliation() {
    setOperatorResearchStatus("loading");
    try {
      const overview = await api<ResearchReconciliationOverview>("/admin/research-reconciliation");
      setOperatorResearch(overview);
      setOperatorResearchStatus("ready");
    } catch {
      setOperatorResearch(null);
      setOperatorResearchStatus("error");
    }
  }

  async function load() {
    const [c, d, s, workspaces, invitations] = await Promise.all([
      api<Candidate[]>("/candidates"),
      api<Draft[]>("/drafts"),
      api<AiSetting>("/ai-settings"),
      api<{ partners: Array<{ id: string; name: string }> }>("/admin/partners"),
      api<{ invitations: PartnerInvitation[]; emailConfigured: boolean }>("/admin/partners/invitations"),
    ]);
    setCandidates(c);
    setDrafts(d);
    setSetting(s);
    setPartnerWorkspaces(workspaces.partners);
    setPartnerInvitations(invitations.invitations);
    setInviteEmailConfigured(invitations.emailConfigured);
    const sources = await api<{ feeds: string[] }>("/discovery/sources");
    setFeeds(sources.feeds);
    setSelectedFeed((previous) => sources.feeds.includes(previous) ? previous : (sources.feeds[0] ?? ""));
  }

  useEffect(() => {
    // Authentication status and subsequent data loading are different phases:
    // a failure in a workspace API must not be reported as an auth outage.
    Promise.all([api<{ authenticated: boolean; conflict?: boolean }>("/session"),
      api<PartnerSession>("/partner/session")])
      .then(([session, partner]) => {
        if (session.conflict || partner.conflict ||
            (session.authenticated && partner.authenticated)) {
          setLoggedIn(false);
          setPartnerSession(null);
          setSessionConflict(true);
          return;
        }
        setSessionConflict(false);
        if (session.authenticated) {
          setLoggedIn(true);
          void load().catch(error =>
            setError(error instanceof Error ? error.message : "Admin data could not load"));
        } else if (partner.authenticated) {
          setPartnerSession(partner);
          void Promise.allSettled([
            loadGoogleConnections(), loadGmailStatus(), loadPersonalAiSettings(),
            loadResearchLimits(), loadResearchBudget(), loadMyProfile(),
          ]);
        }
      })
      .catch(() => setError("Unable to reach the authentication API"));
  }, []);

  useEffect(() => {
    // Cookies are browser-wide. An OAuth login in another tab can replace the
    // current role without rerendering this already mounted React tree.
    // Revalidate on returning to this tab and discard stale privileged data.
    if (!loggedIn && !partnerSession?.authenticated) return;
    let inFlight = false;
    let disposed = false;
    const checkChangedIdentity = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const [admin, partner] = await Promise.all([
          api<{ authenticated: boolean; conflict?: boolean }>("/session"),
          api<PartnerSession>("/partner/session"),
        ]);
        if (disposed) return;
        if (admin.conflict || partner.conflict ||
            (loggedIn && !admin.authenticated) ||
            (partnerSession?.authenticated &&
              (!partner.authenticated || partner.userId !== partnerSession.userId))) {
          // Reload re-evaluates the authoritative cookie state; no stale
          // workspace data remains mounted from the previous browser identity.
          window.location.reload();
        }
      } catch {
        // Network failure must not silently replace an identity or authorize
        // privileged actions; server-side authorization remains authoritative.
      } finally {
        inFlight = false;
      }
    };
    const onVisibility = () => { void checkChangedIdentity(); };
    window.addEventListener("focus", onVisibility);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onVisibility);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loggedIn, partnerSession?.authenticated]);

  useEffect(() => {
    // Read-only server progress refresh, not an autonomous executor or AI call.
    if (!activeWorkspaceId || !campaignProgressId ||
        campaignProgressStatus !== "ready") return;
    const generation = workspaceRequest.current;
    const opened = campaignProgressRequest.current;
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const progress = await api<CampaignProgress>("/research-campaigns/" +
          encodeURIComponent(campaignProgressId) + "/progress?workspaceId=" +
          encodeURIComponent(activeWorkspaceId));
        if (!disposed && generation === workspaceRequest.current &&
            opened === campaignProgressRequest.current) {
          setCampaignProgress(progress);
          setCampaignProgressLastSeen(Date.now());
          setCampaignProgressLiveWarning(false);
          void loadCampaignRunApproval(activeWorkspaceId, campaignProgressId);
          void loadCampaignEmailTriage(activeWorkspaceId, campaignProgressId);
        }
      } catch {
        if (!disposed && generation === workspaceRequest.current &&
            opened === campaignProgressRequest.current) {
          setCampaignProgressLiveWarning(true);
        }
      } finally {
        inFlight = false;
      }
    };
    const interval = window.setInterval(() => void refresh(), 6_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [activeWorkspaceId, campaignProgressId, campaignProgressStatus]);

  async function loadMyProfile() {
    setProfileState("loading");
    try {
      setMyProfile(await api<PartnerSelfProfile>("/partner/profile"));
      setProfileState("ready");
    } catch {
      setProfileState("error");
    }
  }

  async function saveMyProfile(event: React.FormEvent) {
    event.preventDefault();
    if (!myProfile || profileSaving) return;
    setProfileSaving(true);
    setError("");
    try {
      const { email: _readonlyEmail, ...editable } = myProfile;
      const saved = await api<PartnerSelfProfile>("/partner/profile", {
        method: "PUT", body: JSON.stringify(editable),
      });
      setMyProfile(saved);
      setPartnerSession(previous => previous ? { ...previous, displayName: saved.displayName } : previous);
      setNotice("Your personal sender profile has been saved. This does not enable email sending.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save profile");
    } finally {
      setProfileSaving(false);
    }
  }

  async function viewWorkspace(workspaceId: string) {
    // An earlier response must never render under a newly selected workspace.
    const generation = ++workspaceRequest.current;
    ++campaignProgressRequest.current;
    batchStopRequested.current = true;
    setCampaignBatchCompleted(0);
    setCampaignTestBusy(false);
    setCampaignPaidConfirmed(false);
    setSkipChargeConfirmed(false);
    setCampaignTestNotice("");
    campaignCreateIdempotency.current = null;
    setCampaignProgressId(null);
    setCampaignProgress(null);
    setCampaignProgressStatus("idle");
    ++partnerEvidenceRequest.current;
    ++partnerReviewRequest.current;
    ++personEmailRequest.current;
    setPersonEmailCandidateId(null);
    setPersonEmailEvidence(null);
    setPersonEmailBusy(false);
    setPersonEmailConfirmed(false);
    setPartnerReviewSaving(false);
    setReviewId(null);
    setPartnerEvidenceId(null);
    setPartnerEvidenceRows([]);
    setPartnerEvidenceState("idle");
    setPartnerEvidenceUrl("");
    setPartnerEvidenceNote("");
    setActiveWorkspaceId(workspaceId);
    setResearchResult(null);
    setResearchStatus("idle");
    setResearchError("");
    setWorkspaceCandidates([]);
    setWorkspaceDrafts([]);
    setWorkspaceCampaigns([]);
    setCampaignListStatus("idle");
    setWorkspaceDataStatus("loading");
    try {
      const q = "?workspaceId=" + encodeURIComponent(workspaceId);
      const [leads, messages] = await Promise.all([
        api<Candidate[]>("/candidates" + q),
        api<Draft[]>("/drafts" + q),
      ]);
      if (workspaceRequest.current !== generation) return;
      setWorkspaceCandidates(leads);
      setWorkspaceDrafts(messages);
      setWorkspaceDataStatus("ready");
      // Campaign status is supplemental: a failure must not hide valid leads.
      try {
        const campaigns = await api<CampaignSummary[]>("/research-campaigns" + q);
        if (workspaceRequest.current !== generation) return;
        setWorkspaceCampaigns(campaigns);
        setCampaignListStatus("ready");
      } catch {
        if (workspaceRequest.current !== generation) return;
        setCampaignListStatus("error");
      }
    } catch {
      if (workspaceRequest.current !== generation) return;
      setWorkspaceCandidates([]);
      setWorkspaceDrafts([]);
      setWorkspaceCampaigns([]);
      setCampaignListStatus("error");
      setWorkspaceDataStatus("error");
    }
  }

  const onlyWorkspaceId = singleAuthorizedWorkspaceId(partnerSession);
  useEffect(() => {
    // Auto-open only when the authenticated user has exactly one workspace.
    // A new session or workspace identity changes this dependency; switching
    // workspaces still uses viewWorkspace's generation-fenced API requests.
    if (onlyWorkspaceId && activeWorkspaceId !== onlyWorkspaceId) {
      void viewWorkspace(onlyWorkspaceId);
    }
  }, [partnerSession?.userId, onlyWorkspaceId]);

  async function refreshCampaignList(workspaceId: string, generation: number) {
    const items = await api<CampaignSummary[]>("/research-campaigns?workspaceId=" +
      encodeURIComponent(workspaceId));
    if (workspaceRequest.current !== generation) return;
    setWorkspaceCampaigns(items);
    setCampaignListStatus("ready");
  }

  async function createManualTestCampaign(workspaceId: string) {
    if (campaignTestBusy || activeWorkspaceId !== workspaceId ||
        campaignTestQuery.trim().length < 12 || campaignTestQuery.trim().length > 240) return;
    const generation = workspaceRequest.current;
    setCampaignTestBusy(true);
    setCampaignTestNotice("");
    try {
      // Retain this UUID when a request outcome is uncertain so a repeat
      // click cannot create an unintended second campaign.
      const idempotencyKey = campaignCreateIdempotency.current ??
        crypto.randomUUID();
      campaignCreateIdempotency.current = idempotencyKey;
      const result = await api<{ id: string }>("/research-campaigns?workspaceId=" +
        encodeURIComponent(workspaceId), {
        method: "POST",
        body: JSON.stringify({ query: campaignTestQuery.trim(),
          targetCount: 100, idempotencyKey }),
      });
      if (generation !== workspaceRequest.current) return;
      campaignCreateIdempotency.current = null;
      await refreshCampaignList(workspaceId, generation);
      setCampaignTestNotice("100-candidate research plan saved. No paid AI calls have run.");
      await openCampaignProgress(workspaceId, result.id);
    } catch (error) {
      if (generation === workspaceRequest.current) setCampaignTestNotice(
        "Campaign planning failed: " +
        (error instanceof Error ? error.message : "Unknown error") +
        ". Retrying uses the same idempotency key.");
    } finally {
      if (generation === workspaceRequest.current) setCampaignTestBusy(false);
    }
  }

  async function executeManualCampaignTask(workspaceId: string, campaignId: string) {
    if (batchInFlight.current || campaignTestBusy || !campaignPaidConfirmed ||
        activeWorkspaceId !== workspaceId ||
        !personalAi.keyConfigured ||
        !researchBudget.enforcedForPaidSearch ||
        researchBudget.monthlyLimitCents == null ||
        researchBudget.reconciliation?.needsReview === true ||
        budgetStatus !== "ready" || personalAiStatus !== "ready") return;
    const generation = workspaceRequest.current;
    // One approval covers only the currently queued work on this campaign.
    // Server-side cost/identity/lease checks remain authoritative per call.
    const approvedMaxTasks = Math.min(24, campaignProgress?.id === campaignId ?
      campaignProgress.tasks.queued : 24);
    if (approvedMaxTasks < 1) return;
    batchInFlight.current = true;
    batchStopRequested.current = false;
    setCampaignBatchCompleted(0);
    campaignBatchProgressRef.current = 0;
    setCampaignTestBusy(true);
    setCampaignPaidConfirmed(false);
    setCampaignTestNotice("");
    try {
      const result = await runApprovedCampaignBatch({
        maxTasks: approvedMaxTasks,
        shouldStop: () => batchStopRequested.current ||
          generation !== workspaceRequest.current,
        readState: async () => {
          const [progress, budget] = await Promise.all([
            api<CampaignProgress>("/research-campaigns/" +
              encodeURIComponent(campaignId) + "/progress?workspaceId=" +
              encodeURIComponent(workspaceId)),
            api<ResearchBudget>("/research-budget"),
          ]);
          if (generation === workspaceRequest.current) {
            setCampaignProgress(progress);
            setResearchBudget(budget);
          }
          return {
            operationalState: progress.operationalState,
            needsReconciliation: progress.needsReconciliation,
            budgetReady: budget.enforcedForPaidSearch &&
              budget.reconciliation?.needsReview !== true &&
              budget.ledger?.pendingReservations === 0,
          };
        },
        execute: async () => {
          // Exactly one provider attempt per request; server enforces daily
          // quota, price envelope, workspace ownership and lease fencing.
          await api("/research-campaigns/" + encodeURIComponent(campaignId) +
            "/execute-next?workspaceId=" + encodeURIComponent(workspaceId), {
            method: "POST", body: JSON.stringify({ maxTasks: 1 }),
          });
        },
        onWaiting: delay => {
          if (generation === workspaceRequest.current) {
            setCampaignTestNotice("Respecting the campaign rate limit (" +
              Math.ceil(delay / 1000) + "s before the next task). " +
              campaignBatchProgressRef.current + " tasks completed.");
          }
        },
        onProgress: completed => {
          if (generation === workspaceRequest.current) {
            setCampaignBatchCompleted(completed);
            campaignBatchProgressRef.current = completed;
            setCampaignTestNotice(completed + " / " + approvedMaxTasks +
              " research tasks completed in this run. Looking for the next eligible task.");
          }
        },
      });
      if (generation === workspaceRequest.current) {
        const finalMessage = result.status === "STOPPED"
          ? "Stopped at your request."
          : result.status === "RUN_LIMIT_REACHED"
          ? "Approved run limit reached. Check campaign status."
          : result.operationalState === "COMPLETED"
          ? "100 cited candidates reached."
          : result.operationalState === "PARTIAL"
          ? "All planned tasks finished below target. Review results."
          : result.operationalState === "PAUSED_REVIEW"
          ? "Provider response or billing needs manual review. No automatic retry."
          : "Campaign or budget requires review before continuing.";
        setCampaignTestNotice(result.completed + " / " + approvedMaxTasks +
          " tasks executed. " + finalMessage +
          " No email messages were sent.");
      }
    } catch (error) {
      // No automatic retry, even for 429 or lost network responses.
      if (generation === workspaceRequest.current) setCampaignTestNotice(
        "Batch stopped after " + campaignBatchProgressRef.current +
        " completed tasks: " + (error instanceof Error ? error.message : "Unknown error") +
        ". Check progress and spend before any further paid request.");
    } finally {
      batchInFlight.current = false;
      if (generation === workspaceRequest.current) {
        setCampaignTestBusy(false);
        await openCampaignProgress(workspaceId, campaignId);
        try { await refreshCampaignList(workspaceId, generation); }
        catch { setCampaignListStatus("error"); }
        try {
          const budget = await api<ResearchBudget>("/research-budget");
          if (generation === workspaceRequest.current) setResearchBudget(budget);
        } catch {
          if (generation === workspaceRequest.current) setBudgetStatus("error");
        }
      }
    }
  }

  async function skipUncertainCampaignTask(workspaceId: string,
    campaignId: string, taskIndex: number) {
    if (!skipChargeConfirmed || campaignTestBusy ||
        activeWorkspaceId !== workspaceId || !Number.isInteger(taskIndex)) return;
    const generation = workspaceRequest.current;
    setCampaignTestBusy(true);
    setSkipChargeConfirmed(false);
    setCampaignTestNotice("");
    try {
      // Explicit operator decision, never a provider call or refund.
      const outcome = await api<{ code: string; conservativeChargeCents?: number }>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/skip-uncertain-task?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST",
          body: JSON.stringify({ taskIndex, confirmNoRetry: true,
            acceptConservativeCharge: true }),
        });
      if (generation !== workspaceRequest.current) return;
      setCampaignTestNotice(outcome.code === "ALREADY_SKIPPED" ?
        "This task was already skipped. Review the remaining work." :
        "Paused task skipped without provider retry. Conservatively settled costs remain charged. Check provider invoices separately.");
    } catch (error) {
      if (generation === workspaceRequest.current) setCampaignTestNotice(
        "Skip refused: " + (error instanceof Error ? error.message :
          "Reconciliation required") +
        ". The campaign remains paused; do not retry the paid task.");
    } finally {
      if (generation === workspaceRequest.current) {
        setCampaignTestBusy(false);
        await openCampaignProgress(workspaceId, campaignId);
        try { await refreshCampaignList(workspaceId, generation); }
        catch { setCampaignListStatus("error"); }
      }
    }
  }

  async function loadCampaignRunApproval(workspaceId: string, campaignId: string) {
    const generation = workspaceRequest.current;
    const request = campaignProgressRequest.current;
    try {
      const result = await api<CampaignRunApprovalState>("/research-campaigns/" +
        encodeURIComponent(campaignId) + "/approved-run?workspaceId=" +
        encodeURIComponent(workspaceId));
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) {
        setCampaignRunApproval(result);
      }
    } catch {
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) {
        setCampaignRunApproval(null);
      }
    }
  }

  async function stopCampaignAutonomousRun(workspaceId: string, campaignId: string) {
    if (campaignRunApprovalBusy || activeWorkspaceId !== workspaceId ||
        campaignProgressId !== campaignId ||
        !["APPROVED", "RUNNING"].includes(campaignRunApproval?.run?.status ?? "")) return;
    const generation = workspaceRequest.current;
    const request = campaignProgressRequest.current;
    setCampaignRunApprovalBusy(true);
    try {
      const result = await api<{ run: ApprovedCampaignRun }>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/approved-run/stop?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST", body: JSON.stringify({ confirmStop: true }),
        });
      if (generation !== workspaceRequest.current ||
          request !== campaignProgressRequest.current) return;
      setCampaignRunApproval(current => current
        ? { ...current, run: result.run } : null);
      setCampaignRunApprovalNotice("Run stopped. An already dispatched provider call may still be billed; it will not be replayed.");
    } catch (error) {
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) {
        setCampaignRunApprovalNotice(error instanceof Error
          ? error.message : "Run could not be stopped. Check its status.");
      }
    } finally {
      if (generation === workspaceRequest.current) setCampaignRunApprovalBusy(false);
    }
  }

  async function approveCampaignAutonomousRun(workspaceId: string, campaignId: string) {
    const price = campaignRunApproval?.priceEnvelope;
    if (!price || !campaignRunApproval?.autonomousRunEnabled ||
        !campaignNoReplayConfirmed || campaignRunApprovalBusy ||
        activeWorkspaceId !== workspaceId || campaignProgressId !== campaignId) return;
    const generation = workspaceRequest.current;
    const request = campaignProgressRequest.current;
    setCampaignRunApprovalBusy(true);
    setCampaignRunApprovalNotice("");
    try {
      const result = await api<{ run: ApprovedCampaignRun }>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/approve-run?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST",
          body: JSON.stringify({
            maxTasks: campaignMaxTasks,
            maxWorstCaseCents: campaignMaxTasks * price.worstCasePerCallCents,
            confirmConservativeBudget: true,
            confirmNoAutomaticRetry: true,
          }),
        });
      if (generation !== workspaceRequest.current ||
          request !== campaignProgressRequest.current) return;
      setCampaignRunApproval(current => current
        ? { ...current, run: result.run } : null);
      setCampaignRunApprovalNotice("Campaign execution approved. The server " +
        "will run within your saved ceiling while the worker is available. " +
        "A provider/billing uncertainty stops the run without retry.");
      setCampaignNoReplayConfirmed(false);
    } catch (error) {
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) {
        setCampaignRunApprovalNotice(error instanceof Error
          ? error.message : "Campaign approval failed.");
      }
    } finally {
      if (generation === workspaceRequest.current) setCampaignRunApprovalBusy(false);
    }
  }

  async function loadCampaignEmailTriage(workspaceId: string, campaignId: string) {
    const generation = workspaceRequest.current;
    const request = campaignProgressRequest.current;
    try {
      const state = await api<CampaignEmailTriageState>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/email-triage?workspaceId=" + encodeURIComponent(workspaceId));
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) {
        setCampaignEmailTriage(state);
      }
    } catch {
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) setCampaignEmailTriage(null);
    }
  }

  async function changeCampaignEmailTriage(workspaceId: string,
    campaignId: string, action: "start" | "stop") {
    if (campaignTriageBusy || workspaceId !== activeWorkspaceId ||
        campaignId !== campaignProgressId) return;
    if (action === "start" && (!campaignTriageConfirmed ||
        !campaignEmailTriage?.enabled)) return;
    const generation = workspaceRequest.current;
    const request = campaignProgressRequest.current;
    setCampaignTriageBusy(true);
    setCampaignTriageNotice("");
    try {
      await api("/research-campaigns/" + encodeURIComponent(campaignId) +
        "/email-triage/" + action + "?workspaceId=" +
        encodeURIComponent(workspaceId), {
          method: "POST",
          body: JSON.stringify(action === "start" ? {
            maxPages: Math.min(campaignProgress?.uniqueSourcedCandidates ?? 0, 250),
            confirmPublicInspection: true,
          } : { confirmStop: true }),
        });
      if (generation !== workspaceRequest.current ||
          request !== campaignProgressRequest.current) return;
      setCampaignTriageConfirmed(false);
      setCampaignTriageNotice(action === "start"
        ? "Public-profile triage approved. Only cited profiles will be checked. " +
          "Emails require separate review; no contacts or messages are created."
        : "Future profile inspections stopped. An in-progress read may finish.");
      await loadCampaignEmailTriage(workspaceId, campaignId);
    } catch (error) {
      if (generation === workspaceRequest.current &&
          request === campaignProgressRequest.current) {
        setCampaignTriageNotice(error instanceof Error
          ? error.message : "Could not change public-profile inspection state.");
      }
    } finally {
      if (generation === workspaceRequest.current) setCampaignTriageBusy(false);
    }
  }

  async function openCampaignProgress(workspaceId: string, campaignId: string) {
    if (activeWorkspaceId !== workspaceId) return;
    // Acknowledgement is task/snapshot-specific, never sticky across
    // refreshes, workspaces or a different campaign.
    setSkipChargeConfirmed(false);
    const workspaceGeneration = workspaceRequest.current;
    const request = ++campaignProgressRequest.current;
    ++campaignObservationsRequest.current;
    setCampaignObservations([]);
    setCampaignObservationsCursor(null);
    setCampaignObservationsStatus("idle");
    setCampaignEmailInspections({});
    setCampaignEmailInspectionError({});
    setCampaignEmailInspectionBusy(null);
    setCampaignContactConfirm({});
    setCampaignContactSaveNotice({});
    setCampaignContactSaveBusy(null);
    ++manualSourceRequest.current;
    setManualSourceDraft("");
    setManualSources([]);
    setManualSourceStatus("idle");
    setManualSourceNotice("");
    setCampaignProgressLastSeen(null);
    setCampaignProgressLiveWarning(false);
    setCampaignRunApproval(null);
    setCampaignRunApprovalNotice("");
    setCampaignRunApprovalBusy(false);
    setCampaignNoReplayConfirmed(false);
    setCampaignMaxTasks(10);
    setCampaignEmailTriage(null);
    setCampaignTriageBusy(false);
    setCampaignTriageConfirmed(false);
    setCampaignTriageNotice("");
    setCampaignProgressId(campaignId);
    setCampaignProgress(null);
    setCampaignProgressStatus("loading");
    try {
      // This endpoint is strictly read-only and never invokes AI providers.
      const snapshot = await api<CampaignProgress>("/research-campaigns/" +
        encodeURIComponent(campaignId) + "/progress?workspaceId=" +
        encodeURIComponent(workspaceId));
      if (workspaceRequest.current !== workspaceGeneration ||
          campaignProgressRequest.current !== request) return;
      setCampaignProgress(snapshot);
      setCampaignProgressLastSeen(Date.now());
      setCampaignProgressLiveWarning(false);
      setCampaignProgressStatus("ready");
      void loadCampaignRunApproval(workspaceId, campaignId);
      void loadCampaignEmailTriage(workspaceId, campaignId);
    } catch {
      if (workspaceRequest.current !== workspaceGeneration ||
          campaignProgressRequest.current !== request) return;
      setCampaignProgressStatus("error");
    }
  }

  async function loadCampaignObservations(workspaceId: string, campaignId: string,
    after: string | null = null) {
    if (activeWorkspaceId !== workspaceId || campaignProgressId !== campaignId ||
        campaignObservationsStatus === "loading") return;
    const generation = workspaceRequest.current;
    const request = ++campaignObservationsRequest.current;
    setCampaignObservationsStatus("loading");
    try {
      // Reuse the already owner- and workspace-scoped read endpoint.
      // No provider calls, contact verification or candidate import here.
      const page = await api<CampaignObservationsPage>("/research-campaigns/" +
        encodeURIComponent(campaignId) + "/observations?workspaceId=" +
        encodeURIComponent(workspaceId) + (after ? "&after=" +
          encodeURIComponent(after) : ""));
      if (generation !== workspaceRequest.current ||
          request !== campaignObservationsRequest.current) return;
      setCampaignObservations(current => after
        ? [...current, ...page.observations.filter(item =>
          !current.some(existing => existing.id === item.id))]
        : page.observations);
      setCampaignObservationsCursor(page.nextCursor);
      setCampaignObservationsStatus("ready");
    } catch {
      if (generation !== workspaceRequest.current ||
          request !== campaignObservationsRequest.current) return;
      setCampaignObservationsStatus("error");
    }
  }

  async function inspectCampaignObservationEmail(workspaceId: string,
    campaignId: string, observationId: string) {
    if (activeWorkspaceId !== workspaceId || campaignProgressId !== campaignId ||
        campaignEmailInspectionBusy !== null) return;
    const generation = workspaceRequest.current;
    const request = campaignObservationsRequest.current;
    setCampaignEmailInspectionBusy(observationId);
    setCampaignEmailInspectionError(current => {
      const next = { ...current }; delete next[observationId]; return next;
    });
    try {
      const finding = await api<CampaignEmailInspection>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/observations/" + encodeURIComponent(observationId) +
        "/email-evidence?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST", body: "{}",
        });
      if (generation !== workspaceRequest.current ||
          request !== campaignObservationsRequest.current ||
          campaignProgressId !== campaignId) return;
      setCampaignEmailInspections(current => ({
        ...current, [observationId]: finding,
      }));
    } catch (error) {
      if (generation === workspaceRequest.current &&
          request === campaignObservationsRequest.current) {
        setCampaignEmailInspectionError(current => ({
          ...current, [observationId]: error instanceof Error
            ? error.message : "Unable to inspect this public source.",
        }));
      }
    } finally {
      if (generation === workspaceRequest.current)
        setCampaignEmailInspectionBusy(null);
    }
  }

  async function saveReviewedCampaignContact(workspaceId: string,
    campaignId: string, observationId: string) {
    const finding = campaignEmailInspections[observationId];
    if (workspaceId !== activeWorkspaceId || campaignProgressId !== campaignId ||
        campaignContactSaveBusy !== null || !campaignContactConfirm[observationId] ||
        !finding?.observedEmail || !finding.reviewRequired ||
        !finding.evidenceDigest) return;
    const generation = workspaceRequest.current;
    const request = campaignObservationsRequest.current;
    setCampaignContactSaveBusy(observationId);
    try {
      const response = await api<{
        candidateId: string; code: string; contactCreated: boolean;
      }>("/research-campaigns/" + encodeURIComponent(campaignId) +
        "/observations/" + encodeURIComponent(observationId) +
        "/accept-contact?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST", body: JSON.stringify({
            expectedDigest: finding.evidenceDigest,
            confirmsExactPersonEmailPair: true,
          }),
        });
      if (generation !== workspaceRequest.current ||
          request !== campaignObservationsRequest.current ||
          campaignProgressId !== campaignId) return;
      setCampaignObservations(current => current.map(item =>
        item.id === observationId ? { ...item, candidateId: response.candidateId } : item));
      setCampaignContactSaveNotice(current => ({
        ...current, [observationId]: "Contact saved for further review. " +
          "No email was sent or authorized.",
      }));
      setCampaignContactConfirm(current => ({
        ...current, [observationId]: false,
      }));
    } catch (error) {
      if (generation === workspaceRequest.current &&
          request === campaignObservationsRequest.current) {
        setCampaignContactSaveNotice(current => ({
          ...current, [observationId]: error instanceof Error ? error.message :
            "Could not accept the reviewed contact.",
        }));
      }
    } finally {
      if (generation === workspaceRequest.current)
        setCampaignContactSaveBusy(null);
    }
  }

  async function loadManualCampaignSources(workspaceId: string, campaignId: string) {
    if (workspaceId !== activeWorkspaceId || campaignProgressId !== campaignId) return;
    const generation = workspaceRequest.current;
    const request = ++manualSourceRequest.current;
    setManualSourceStatus("loading");
    try {
      const result = await api<CampaignSourcesResponse>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/sources?workspaceId=" + encodeURIComponent(workspaceId));
      if (generation !== workspaceRequest.current ||
          request !== manualSourceRequest.current) return;
      setManualSources(result.sources);
      setManualSourceStatus("ready");
    } catch {
      if (generation !== workspaceRequest.current ||
          request !== manualSourceRequest.current) return;
      setManualSourceStatus("error");
    }
  }

  async function queueManualCampaignSources(workspaceId: string, campaignId: string) {
    if (workspaceId !== activeWorkspaceId || campaignProgressId !== campaignId ||
        manualSourceBusy) return;
    const urls = manualSourceDraft.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
    if (!urls.length || urls.length > 25) {
      setManualSourceNotice("Enter 1 to 25 public HTTPS URLs, one per line.");
      return;
    }
    const generation = workspaceRequest.current;
    setManualSourceBusy(true);
    setManualSourceNotice("");
    try {
      const result = await api<{ added: number; submitted: number }>(
        "/research-campaigns/" + encodeURIComponent(campaignId) +
        "/sources?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST", body: JSON.stringify({ urls }),
        });
      if (generation !== workspaceRequest.current) return;
      setManualSourceDraft("");
      setManualSourceNotice(result.added + " new source(s) queued for future enrichment. " +
        "No AI search or email inspection has been started.");
      await loadManualCampaignSources(workspaceId, campaignId);
    } catch (error) {
      if (generation === workspaceRequest.current)
        setManualSourceNotice(error instanceof Error ? error.message :
          "Could not save source URLs.");
    } finally {
      if (generation === workspaceRequest.current) setManualSourceBusy(false);
    }
  }

  async function inspectCandidatePersonEmail(workspaceId: string, candidateId: string) {
    if (activeWorkspaceId !== workspaceId || personEmailBusy) return;
    const generation = workspaceRequest.current;
    const request = ++personEmailRequest.current;
    const url = "/candidates/" + encodeURIComponent(candidateId) +
      "/direct-email-evidence?workspaceId=" + encodeURIComponent(workspaceId);
    setPersonEmailCandidateId(candidateId);
    setPersonEmailEvidence(null);
    setPersonEmailConfirmed(false);
    setPersonEmailBusy(true);
    setError("");
    try {
      // Only the server chooses the candidate's profile and independently
      // inspects it. No client-supplied email or source URL is trusted.
      await api(url, { method: "POST", body: "{}" });
      const result = await api<DirectEmailEvidenceResponse>(url);
      if (workspaceRequest.current !== generation ||
          personEmailRequest.current !== request) return;
      setPersonEmailEvidence(result);
      setNotice("Public person-email evidence found for review. No contact was approved.");
    } catch (err) {
      if (workspaceRequest.current !== generation ||
          personEmailRequest.current !== request) return;
      setError(err instanceof Error ? err.message : "Profile email inspection unavailable");
    } finally {
      if (workspaceRequest.current === generation &&
          personEmailRequest.current === request) setPersonEmailBusy(false);
    }
  }

  async function approveCandidatePersonEmail(workspaceId: string) {
    const candidateId = personEmailCandidateId;
    const observation = personEmailEvidence?.observation;
    if (!candidateId || !observation || !observation.reviewRequired ||
        !personEmailConfirmed || personEmailBusy ||
        activeWorkspaceId !== workspaceId) return;
    const generation = workspaceRequest.current;
    const request = personEmailRequest.current;
    setPersonEmailBusy(true);
    setError("");
    try {
      await api("/candidates/" + encodeURIComponent(candidateId) +
        "/direct-email-evidence/review?workspaceId=" +
        encodeURIComponent(workspaceId), {
          method: "POST",
          body: JSON.stringify({
            expectedDigest: observation.evidenceDigest,
            confirmsExactPersonEmailPair: true,
          }),
        });
      if (workspaceRequest.current !== generation ||
          personEmailRequest.current !== request) return;
      await viewWorkspace(workspaceId);
      setNotice("Exact person-email association reviewed. Mailbox, legal basis and suppression checks are still required before outreach.");
    } catch (err) {
      if (workspaceRequest.current !== generation ||
          personEmailRequest.current !== request) return;
      setError(err instanceof Error ? err.message : "Person-email review failed");
    } finally {
      if (workspaceRequest.current === generation &&
          personEmailRequest.current === request) setPersonEmailBusy(false);
    }
  }

  async function openPartnerEvidence(workspaceId: string, candidateId: string) {
    if (workspaceId !== activeWorkspaceId) return;
    const currentWorkspace = workspaceRequest.current;
    const request = ++partnerEvidenceRequest.current;
    setPartnerEvidenceId(candidateId);
    setPartnerEvidenceRows([]);
    setPartnerEvidenceUrl("");
    setPartnerEvidenceNote("");
    setPartnerEvidenceState("loading");
    try {
      const items = await api<Evidence[]>("/candidates/" + encodeURIComponent(candidateId) +
        "/evidence?workspaceId=" + encodeURIComponent(workspaceId));
      if (currentWorkspace !== workspaceRequest.current ||
          request !== partnerEvidenceRequest.current) return;
      setPartnerEvidenceRows(items);
      setPartnerEvidenceState("ready");
    } catch {
      if (currentWorkspace !== workspaceRequest.current ||
          request !== partnerEvidenceRequest.current) return;
      setPartnerEvidenceState("error");
    }
  }

  async function savePartnerEvidence(workspaceId: string, event: React.FormEvent) {
    event.preventDefault();
    const candidateId = partnerEvidenceId;
    if (!candidateId || activeWorkspaceId !== workspaceId || partnerEvidenceSaving) return;
    const currentWorkspace = workspaceRequest.current;
    const request = partnerEvidenceRequest.current;
    setPartnerEvidenceSaving(true);
    setError("");
    try {
      const url = "/candidates/" + encodeURIComponent(candidateId) +
        "/evidence?workspaceId=" + encodeURIComponent(workspaceId);
      await api(url, { method: "POST", body: JSON.stringify({
        kind: partnerEvidenceKind, sourceUrl: partnerEvidenceUrl,
        ...(partnerEvidenceNote.trim() ? { note: partnerEvidenceNote.trim() } : {}),
      }) });
      const items = await api<Evidence[]>(url);
      if (currentWorkspace !== workspaceRequest.current ||
          request !== partnerEvidenceRequest.current) return;
      setPartnerEvidenceRows(items);
      setPartnerEvidenceUrl("");
      setPartnerEvidenceNote("");
      setNotice("Source evidence saved for manual review. No outreach was authorized.");
    } catch (err) {
      if (currentWorkspace !== workspaceRequest.current ||
          request !== partnerEvidenceRequest.current) return;
      setError(err instanceof Error ? err.message : "Evidence could not be saved");
    } finally {
      setPartnerEvidenceSaving(false);
    }
  }

  async function saveManualSeed(workspaceId: string, event: React.FormEvent) {
    event.preventDefault();
    if (activeWorkspaceId !== workspaceId || seedSaving) return;
    const generation = workspaceRequest.current;
    setSeedSaving(true);
    setError("");
    try {
      const receipt = await api<{ id: string; created: boolean }>(
        "/candidates?workspaceId=" + encodeURIComponent(workspaceId), {
          method: "POST",
          body: JSON.stringify({
            manualSeed: true, name: seedName.trim(), category: seedCategory,
            sourceUrl: seedUrl.trim(),
          }),
        });
      if (workspaceRequest.current !== generation) return;
      setSeedName("");
      setSeedUrl("");
      await viewWorkspace(workspaceId);
      setNotice(receipt.created ? "Lead saved for manual review. No contact was authorized." :
        "This candidate and source already exist in this workspace.");
    } catch (err) {
      if (workspaceRequest.current !== generation) return;
      setError(err instanceof Error ? err.message : "Manual lead could not be saved");
    } finally {
      setSeedSaving(false);
    }
  }

  function prepareIndependentResearch(item: Candidate) {
    try {
      const research = manualIndependentResearch(item.name, item.category,
        item.sourceUrl ?? item.researchCitationUrl ?? "");
      // No AI call, no source fetch and no provider charge on this action.
      setResearchQuery(research.criteria);
      setResearchResult(null);
      setResearchError("");
      setResearchStatus("idle");
      setPartnerTab("discovery");
      setNotice("Independent research criteria prepared. The original source domain " +
        research.excludedHostname + " is excluded from the query text, not technically blocked " +
        "by the AI provider. Do not launch automated research until source-policy controls " +
        "and spending limits have been approved.");
    } catch {
      setError("A public HTTPS profile reference is needed before preparing research.");
    }
  }

  function openIndependentManualSearch(item: Candidate) {
    if (!item.sourceUrl) {
      setError("This candidate has no durable public source to search from yet.");
      return;
    }
    try {
      const research = manualIndependentResearch(item.name, item.category, item.sourceUrl);
      // Browser navigation only, initiated by a human; the app does no scraping.
      window.open(research.searchUrl, "_blank", "noopener,noreferrer");
    } catch {
      setError("A public HTTPS profile reference is needed before searching independently.");
    }
  }

  async function runResearch(workspaceId: string, event: React.FormEvent) {
    event.preventDefault();
    if (activeWorkspaceId !== workspaceId || researchStatus === "loading") return;
    const generation = workspaceRequest.current;
    setResearchStatus("loading");
    setResearchResult(null);
    setResearchError("");
    setReviewedResearchSources([]);
    setSelectedResearchCandidates([]);
    setReviewedResearchUrls({});
    setSavedResearchCandidates([]);
    try {
      const result = await api<ResearchPreview>("/discovery/ai-research?workspaceId=" +
        encodeURIComponent(workspaceId), {
        method: "POST", body: JSON.stringify({ query: researchQuery.trim(), limit: researchLimits.maxCandidates }),
      });
      if (workspaceRequest.current !== generation || result.workspaceId !== workspaceId) return;
      setResearchResult(result);
      setSelectedResearchCandidates(result.candidates.map(reviewedCandidateKey));
      setResearchStatus("idle");
    } catch (error) {
      if (workspaceRequest.current !== generation) return;
      setResearchStatus("error");
      setResearchError(error instanceof Error ? error.message : "Research unavailable");
    } finally {
      // Provider calls can be billed even when an upstream error occurs.
      if (workspaceRequest.current === generation) void loadResearchBudget();
    }
  }

  async function saveReviewedResearchCandidates(
    workspaceId: string, onlyKey?: string,
  ) {
    // One explicit confirmation can save multiple previously reviewed sources.
    // Reuse the existing transactional, idempotent manualSeed endpoint rather
    // than introducing a second candidate ownership or persistence contract.
    if (!researchResult || activeWorkspaceId !== workspaceId ||
        researchSaveInFlight.current) return;
    const batch = onlyKey
      ? reviewedSeedBatch(researchResult.candidates, reviewedResearchSources,
          reviewedResearchUrls, savedResearchCandidates).filter(seed => seed.key === onlyKey)
      : selectedDiscoverySeedBatch(researchResult.candidates,
          selectedResearchCandidates, savedResearchCandidates);
    if (!batch.length) return;
    const generation = workspaceRequest.current;
    researchSaveInFlight.current = true;
    setSavingResearchCandidate(onlyKey ?? "__batch__");
    setError("");
    let completed = 0;
    let created = 0;
    let failure = "";
    try {
      // Sequential requests preserve server-side workspace serialization and
      // allow deterministic partial progress and safe retries.
      for (const seed of batch) {
        if (workspaceRequest.current !== generation) break;
        try {
          const { key, ...body } = seed;
          const receipt = await api<{ id: string; created: boolean }>(
            "/candidates?workspaceId=" + encodeURIComponent(workspaceId), {
              method: "POST", body: JSON.stringify(body),
            });
          if (workspaceRequest.current !== generation) break;
          completed++;
          if (receipt.created) created++;
          setSavedResearchCandidates(prev => prev.includes(key) ? prev : [...prev, key]);
        } catch (error) {
          failure = error instanceof Error ? error.message : "Candidate save failed";
          break;
        }
      }
      if (workspaceRequest.current !== generation) return;
      if (completed) setNotice(
        completed + " candidates queued (" + created +
        " new). Sources, email ownership and outreach remain UNVERIFIED. No emails sent.");
      if (failure) setError(failure + ". Previously saved candidates remain saved. Retry only unsaved reviewed entries.");
      if (completed) {
        // A list refresh failure must not invalidate successful writes.
        try {
          const updated = await api<Candidate[]>(
            "/candidates?workspaceId=" + encodeURIComponent(workspaceId));
          if (workspaceRequest.current === generation) {
            setWorkspaceCandidates(updated);
            setWorkspaceDataStatus("ready");
          }
        } catch {
          if (workspaceRequest.current === generation) setWorkspaceDataStatus("error");
        }
      }
    } finally {
      researchSaveInFlight.current = false;
      if (workspaceRequest.current === generation) setSavingResearchCandidate(null);
    }
  }

    async function loadResearchBudget() {
    setBudgetStatus("loading");
    try {
      const budget = await api<ResearchBudget>("/research-budget");
      setResearchBudget(budget);
      setBudgetStatus("ready");
    } catch { setBudgetStatus("error"); }
  }

  async function saveResearchBudget(event: React.FormEvent) {
    event.preventDefault();
    if (researchBudget.monthlyLimitCents === null) return;
    await execute(async () => {
      const budget = await api<ResearchBudget>("/research-budget", {
        method: "PUT",
        body: JSON.stringify({ monthlyLimitCents: researchBudget.monthlyLimitCents }),
      });
      setResearchBudget(budget);
      setNotice(budget.enforcedForPaidSearch
        ? "Monthly budget saved. Approved web research is available within your application spending limit."
        : "Monthly budget saved. Research requires an approved model and enabled feature.");
    });
  }

  async function loadResearchLimits() {
    setResearchLimitsStatus("loading");
    try {
      const data = await api<ResearchLimits>("/research-limits");
      setResearchLimits(data);
      setResearchLimitsStatus("ready");
    } catch {
      setResearchLimitsStatus("error");
    }
  }

  async function saveResearchLimits(event: React.FormEvent) {
    event.preventDefault();
    await execute(async () => {
      const data = await api<ResearchLimits>("/research-limits", {
        method: "PUT", body: JSON.stringify(researchLimits),
      });
      setResearchLimits(data);
      setResearchLimitsStatus("ready");
      setNotice("Personal research limits saved. No AI search was started.");
    });
  }

  async function loadPersonalAiSettings() {
    setPersonalAiStatus("loading");
    try {
      const current = await api<AiSetting>("/ai-settings");
      setPersonalAi(current);
      setPersonalAiStatus("ready");
    } catch {
      setPersonalAiStatus("error");
    }
  }

  async function savePersonalAiSettings(event: React.FormEvent) {
    event.preventDefault();
    await execute(async () => {
      await api("/ai-settings", { method: "PUT", body: JSON.stringify({
        provider: personalAi.provider, model: personalAi.model,
        ...(personalApiKey.trim() ? { apiKey: personalApiKey.trim() } : {}),
      }) });
      setPersonalApiKey("");
      await loadPersonalAiSettings();
      // The selected model may change the authoritative server budget readiness.
      await loadResearchBudget();
      setNotice("Your AI key was saved to your account (encrypted). No AI request was made.");
    });
  }

  async function deletePersonalAiSettings() {
    await execute(async () => {
      await api("/ai-settings", { method: "DELETE" });
      setPersonalApiKey("");
      await loadPersonalAiSettings();
      await loadResearchBudget();
      setNotice("Your personal AI key was removed.");
    });
  }

  async function loadGmailStatus() {
    setGmailStatusError(false);
    try {
      setGmailStatus(await api<GmailStatus>("/partner/google/gmail"));
    } catch {
      setGmailStatus(null);
      setGmailStatusError(true);
    }
  }

  async function disconnectGmail() {
    await execute(async () => {
      await api("/partner/google/gmail", { method: "DELETE" });
      await loadGmailStatus();
      setNotice("Gmail authorization removed locally. You may also revoke it in Google Account permissions.");
    });
  }

  async function loadGoogleConnections() {
    setConnectionStatus("loading");
    try {
      const data = await api<ConnectionResponse>("/partner/google/connections");
      setGoogleConnections(data.connections);
      setGoogleConfigured(data.available);
      setConnectionStatus("ready");
    } catch {
      // Do not misrepresent an unavailable status endpoint as disconnected.
      setConnectionStatus("unavailable");
    }
  }

  async function execute(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally { setBusy(false); }
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    await execute(async () => {
      await api("/session", { method: "POST", body: JSON.stringify({ email, password }) });
      setPassword(""); setLoggedIn(true); await load();
    });
  }

  async function logout() {
    await execute(async () => {
      await api("/session", { method: "DELETE" });
      setLoggedIn(false); setCandidates([]); setDrafts([]); setApiKey("");
      setOperatorResearch(null); setOperatorResearchStatus("idle");
    });
  }

  async function switchToPartnerSignIn() {
    // End the privileged admin session before starting a separate OAuth flow.
    await execute(async () => {
      await api("/session", { method: "DELETE" });
      setLoggedIn(false);
      setCandidates([]);
      setDrafts([]);
      setApiKey("");
      setOperatorResearch(null); setOperatorResearchStatus("idle");
      setPassword("");
      window.location.assign("/api/auth/google/start");
    });
  }

  async function logoutPartner() {
    await execute(async () => {
      await api("/partner/session", { method: "DELETE" });
      ++workspaceRequest.current;
      ++campaignProgressRequest.current;
      batchStopRequested.current = true;
      setCampaignPaidConfirmed(false);
      setCampaignTestBusy(false);
      setCampaignTestNotice("");
      campaignCreateIdempotency.current = null;
      setCampaignProgressId(null);
      setCampaignProgress(null);
      setCampaignProgressStatus("idle");
      setPartnerSession(null);
      setGmailStatus(null);
      setGmailStatusError(false);
      setPersonalApiKey("");
      setPersonalAi({ provider: "gemini", model: "gemini-2.5-flash", keyConfigured: false });
      setPersonalAiStatus("loading");
      setResearchLimits({ dailyLimit: 2, maxCandidates: 10, maxConcurrent: 1 });
      setResearchLimitsStatus("loading");
      setResearchBudget({ monthlyLimitCents: null, currency: "USD", enforcedForPaidSearch: false });
      setBudgetStatus("loading");

      ++partnerEvidenceRequest.current;
      ++partnerReviewRequest.current;
      setPartnerReviewSaving(false);
      setReviewId(null);
      setPartnerEvidenceId(null);
      setPartnerEvidenceRows([]);
      setPartnerEvidenceState("idle");
      setActiveWorkspaceId(null);
      setWorkspaceCampaigns([]);
      setCampaignListStatus("idle");
      setWorkspaceCandidates([]);
      setWorkspaceDrafts([]);
      setWorkspaceDataStatus("idle");
      setResearchResult(null);
      setResearchStatus("idle");
      setResearchError("");
      setGoogleConnections([]);
      setConnectionStatus("loading");
      setGoogleConfigured(false);
    });
  }

  async function disconnectGoogle(partnerId: string) {
    await execute(async () => {
      await api("/partner/google/connections/" + encodeURIComponent(partnerId), { method: "DELETE" });
      await loadGoogleConnections();
      setNotice("Google connection removed locally. You can also revoke the app in your Google Account.");
    });
  }

  async function invitePartner(event: React.FormEvent) {
    event.preventDefault();
    await execute(async () => {
      const receipt = await api<{ emailStatus?: string; existing?: boolean }>("/admin/partners/invite", {
        method: "POST", body: JSON.stringify({
          ...(partnerTarget === "new" ? { partnerName } : { partnerId: partnerTarget }),
          email: partnerEmail,
        }),
      });
      const emailSent = receipt.emailStatus === "SENT";
      const status = receipt.existing ? "Already provisioned — no duplicate invitation sent."
        : emailSent ? "Access provisioned and invitation accepted by email provider."
        : "Access provisioned. Invitation email " +
          (receipt.emailStatus === "UNCONFIGURED" ? "not sent: email provider not configured."
            : "not confirmed (" + (receipt.emailStatus ?? "UNKNOWN") + ").");
      setInviteReceipt(status);
      setPartnerName(""); setPartnerEmail("");
      await load();
      setNotice(status);
    });
  }

  async function resendPartnerInvite(id: string, newAttempt: boolean) {
    if (newAttempt && !window.confirm("Send a new invitation email? This may duplicate a previous message.")) return;
    await execute(async () => {
      const result = await api<{ emailStatus: string }>("/admin/partners/invitations/" +
        encodeURIComponent(id) + "/resend", { method: "POST",
        body: JSON.stringify({ newAttempt }) });
      await load();
      setNotice("Invitation send status: " + result.emailStatus);
    });
  }

  async function revokePartnerMembership(invite: PartnerInvitation) {
    if (!window.confirm("Revoke " + invite.email + " access to " + invite.workspace +
      "? This immediately blocks their workspace access but preserves audit history.")) return;
    await execute(async () => {
      const result = await api<{ revoked: boolean; changed: boolean }>(
        "/admin/partners/memberships/" + encodeURIComponent(invite.id), { method: "DELETE" });
      await load();
      setNotice(result.changed ? "Workspace access revoked." : "Workspace access was already revoked.");
    });
  }

  async function saveCandidate(event: React.FormEvent) {
    event.preventDefault();
    await execute(async () => {
      await api("/candidates", { method: "POST", body: JSON.stringify(candidate) });
      await load();
      setCandidate({ ...candidate, name: "", email: "", sourceUrl: "", legalBasis: "", contactReviewed: false });
      setNotice("Candidate added successfully");
    });
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    await execute(async () => {
      const payload = { provider: setting.provider, model: setting.model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      await api("/ai-settings", { method: "PUT", body: JSON.stringify(payload) });
      setApiKey("");
      await load();
      setNotice("AI settings saved. The API key is stored encrypted on the server.");
    });
  }

  async function makeDraft(id: string) {
    await execute(async () => {
      await api("/candidates/" + encodeURIComponent(id) + "/draft", { method: "POST" });
      await load(); setTab("drafts");
      setNotice("Draft generated. Nothing was sent.");
    });
  }

  async function showEvidence(id: string) {
    await execute(async () => {
      const key = encodeURIComponent(id);
      const [rows, matches] = await Promise.all([
        api<Evidence[]>("/candidates/" + key + "/evidence"),
        api<{ suggestions: DuplicateHint[]; incomplete: boolean }>("/candidates/" + key + "/possible-duplicates"),
      ]);
      setEvidenceId(id);
      setEvidence(rows);
      setDuplicateHints(matches.suggestions);
      setDuplicateScanIncomplete(matches.incomplete);
      setEvidenceUrl(""); setEvidenceNote("");
    });
  }

  async function saveEvidence(event: React.FormEvent) {
    event.preventDefault();
    if (!evidenceId) return;
    await execute(async () => {
      const id = encodeURIComponent(evidenceId);
      await api("/candidates/" + id + "/evidence", {
        method: "POST",
        body: JSON.stringify({ kind: evidenceKind, sourceUrl: evidenceUrl, ...(evidenceNote.trim() ? { note: evidenceNote.trim() } : {}) }),
      });
      setEvidence(await api<Evidence[]>("/candidates/" + id + "/evidence"));
      setEvidenceUrl(""); setEvidenceNote("");
      setNotice("Source evidence saved. This does not qualify the expert or allow email outreach.");
    });
  }

  function beginProfileReview(item: Candidate) {
    setReviewId(item.id);
    setReviewProfileUrl(item.expertProfileUrl ?? "");
    setReviewRegion(item.region ?? "");
    setReviewEnglish(item.onlineEnglish);
  }

  async function saveProfileReview(event: React.FormEvent) {
    event.preventDefault();
    if (!reviewId) return;
    await execute(async () => {
      await api("/candidates/" + encodeURIComponent(reviewId) + "/expert-review", {
        method: "PATCH",
        body: JSON.stringify({
          expertProfileUrl: reviewProfileUrl, region: reviewRegion || null,
          onlineEnglish: reviewEnglish, profileReviewed: true,
        }),
      });
      await load();
      setReviewId(null);
      setNotice("Expert profile review saved. Article provenance remains unchanged; no email sent.");
    });
  }

  async function savePartnerProfileReview(workspaceId: string, event: React.FormEvent) {
    event.preventDefault();
    if (!reviewId || workspaceId !== activeWorkspaceId || partnerReviewSaving) return;
    const candidateId = reviewId;
    const currentWorkspace = workspaceRequest.current;
    const request = ++partnerReviewRequest.current;
    setPartnerReviewSaving(true);
    setError("");
    try {
      await api("/candidates/" + encodeURIComponent(candidateId) +
        "/expert-review?workspaceId=" + encodeURIComponent(workspaceId), {
        method: "PATCH",
        body: JSON.stringify({
          expertProfileUrl: reviewProfileUrl, region: reviewRegion || null,
          onlineEnglish: reviewEnglish, profileReviewed: true,
        }),
      });
      if (currentWorkspace !== workspaceRequest.current ||
          request !== partnerReviewRequest.current) return;
      setReviewId(null);
      setNotice("Expert profile review saved. Original article evidence is preserved. No email sent.");
      await viewWorkspace(workspaceId);
    } catch (err) {
      if (currentWorkspace !== workspaceRequest.current ||
          request !== partnerReviewRequest.current) return;
      setError(err instanceof Error ? err.message : "Expert profile review failed");
    } finally {
      if (request === partnerReviewRequest.current) setPartnerReviewSaving(false);
    }
  }

  async function scanSource() {
    await execute(async () => {
      const result = await api<{ entries: FeedEntry[] }>("/discovery/scan", {
        method: "POST", body: JSON.stringify({ feedUrl: selectedFeed }),
      });
      setDiscovered(result.entries);
      setNotice("Read " + result.entries.length + " feed authors. These are unverified prospects, not confirmed experts.");
    });
  }

  async function importLead(entry: FeedEntry) {
    await execute(async () => {
      const result = await api<{ id: string; created: boolean }>("/discovery/import", {
        method: "POST", body: JSON.stringify({
          feedUrl: entry.feedUrl, name: entry.name, sourceUrl: entry.sourceUrl,
          discoveryKey: entry.discoveryKey, proof: entry.proof, category: discoveryCategory,
        }),
      });
      await load();
      setNotice(result.created ? "Imported for manual review — no email sent." : "Already imported; no duplicate created.");
    });
  }

  const readiness = researchReadiness({
    aiStatus: personalAiStatus,
    keyConfigured: personalAi.keyConfigured,
    budgetStatus,
    monthlyLimitCents: researchBudget.monthlyLimitCents,
    enforcedForPaidSearch: researchBudget.enforcedForPaidSearch,
    limitsStatus: researchLimitsStatus,
  });

  if (sessionConflict) return (
    <main className="login-shell">
      <section className="panel login" role="alert">
        <h1>Session conflict</h1>
        <p>Both an administrator session and a Google partner session are
          active in this browser. Access is blocked until both are cleared.
          This does not grant administrator access to the invited partner.</p>
        {error && <p className="error">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void execute(async () => {
          // Reuse both existing sign-out endpoints; no new privileged
          // browser identity-switch API and no implicit role selection.
          await api("/session", { method: "DELETE" });
          await api("/partner/session", { method: "DELETE" });
          window.location.reload();
        })}>Sign out of both sessions</button>
      </section>
    </main>
  );

  if (partnerSession?.authenticated && !loggedIn) return (
    <main className="layout">
      <aside>
        <div className="brand">SNAPYCALL<span> / PILOT</span></div>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="Workspace sections">
          {(["dashboard", "discovery", "candidates", "drafts", "profile", "settings"] as const).map(item =>
            <button type="button" key={item} className={partnerTab === item ? "active" : ""}
              onClick={() => setPartnerTab(item)}>
              {item === "dashboard" ? "Dashboard" : item === "profile" ? "My profile" :
                item === "settings" ? "AI settings" : item === "drafts" ? "Outreach drafts" :
                item === "discovery" ? "Research" : "Candidates"}
            </button>)}
        </nav>
        <div className="sidebar-bottom">
          <span className="state">● Draft-only mode · Partner session</span>
          <button type="button" className="ghost" disabled={busy} onClick={logoutPartner}>Use administrator sign-in</button>
          <button type="button" className="ghost" disabled={busy} onClick={logoutPartner}>Sign out</button>
        </div>
      </aside>
      <section className="content" aria-label="Partner workspace">
        <header><div><span className="eyebrow">SNAPYCALL • PARTNER</span>
          <h1>{partnerTab === "dashboard" ? "Workspace dashboard" : partnerTab === "candidates" ? "Expert candidates" :
            partnerTab === "discovery" ? "Find experts" : partnerTab === "drafts" ? "Outreach drafts" :
            partnerTab === "profile" ? "My profile" : "AI settings"}</h1>
          <p className="muted">Welcome{partnerSession.displayName ? ", " + partnerSession.displayName : ""}.
            Your access is limited to your authorized workspaces.</p>
        </div><span className="pill">No automatic sending</span></header>
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="success" role="status">{notice}</div>}
        {partnerTab === "profile" && <section className="panel" aria-label="Personal sender profile">
          <h2>My profile</h2>
          <p className="muted">These details belong to your signed-in user account across authorized
            workspaces. They can be used for future personalized email drafts and signatures.
            Your verified sign-in email cannot be changed here; saving does not send messages.</p>
          {profileState === "loading" && <p>Loading your profile…</p>}
          {profileState === "error" && <button type="button" className="secondary"
            onClick={() => void loadMyProfile()}>Retry loading profile</button>}
          {profileState === "ready" && myProfile && <form className="form-grid"
            onSubmit={event => void saveMyProfile(event)}>
            <label>Full name<input maxLength={120} value={myProfile.displayName}
              onChange={event => setMyProfile({ ...myProfile, displayName: event.target.value })}/></label>
            <label>Sign-in email (read-only)<input type="email" readOnly value={myProfile.email}/></label>
            <label>Job title<input maxLength={120} value={myProfile.jobTitle}
              onChange={event => setMyProfile({ ...myProfile, jobTitle: event.target.value })}/></label>
            <label>Organization<input maxLength={160} value={myProfile.organizationName}
              onChange={event => setMyProfile({ ...myProfile, organizationName: event.target.value })}/></label>
            <label>Business phone<input type="tel" maxLength={32} value={myProfile.businessPhone}
              onChange={event => setMyProfile({ ...myProfile, businessPhone: event.target.value })}/></label>
            <label>Public website (HTTPS)<input type="url" maxLength={2048}
              value={myProfile.publicWebsite}
              onChange={event => setMyProfile({ ...myProfile, publicWebsite: event.target.value })}/></label>
            <label className="wide">Email signature (plain text)
              <textarea maxLength={1000} rows={5} value={myProfile.emailSignature}
                onChange={event => setMyProfile({ ...myProfile, emailSignature: event.target.value })}/>
            </label>
            <p className="wide muted">Profile details are never inserted into an email
              automatically in this release. A future approved template flow will render
              them safely, with a preview and explicit sending authorization.</p>
            <button type="submit" disabled={profileSaving}>
              {profileSaving ? "Saving…" : "Save my profile"}
            </button>
          </form>}
        </section>}
        {partnerTab !== "settings" && partnerTab !== "profile" && <section className="panel">
          <p className="muted">Candidate and draft data are workspace-scoped.
            You may manually save inspected AI-research candidates for further review.
            Contact verification, automated importing, AI drafting and sending
            remain disabled until their separate authorization gates are released.</p>
        <h2>{partnerTab === "dashboard" ? "Choose your workspace" : "My workspaces"}</h2>
        {connectionStatus === "unavailable" && <div role="alert">
          <p>Google connection status is unavailable. No connection changes have been assumed.</p>
          <button className="secondary" disabled={busy} onClick={() => void loadGoogleConnections()}>
            Retry connection status
          </button>
        </div>}
        {(partnerSession.partners ?? []).map(p => {
          const connection = googleConnections.find(c => c.partnerId === p.id);
          return <div key={p.id}>
            <p><strong>{p.name}</strong> · {p.role}</p>
            <button type="button" className="secondary" disabled={busy}
              onClick={() => void viewWorkspace(p.id)}>
              {activeWorkspaceId === p.id ? "Refresh workspace" : "Open workspace"}
            </button>
            {activeWorkspaceId === p.id &&
              <section aria-label={"Workspace " + p.name}>
                {partnerTab === "dashboard" && <div className="workspace-dashboard" aria-label="Workspace overview">
                  <div className="dashboard-intro">
                    <h3>Get started with expert research</h3>
                    <p className="muted">Find experts, save candidates for review and prepare outreach.
                      Nothing is sent automatically.</p>
                    <button type="button" onClick={() => setPartnerTab("discovery")}>
                      Find experts
                    </button>
                  </div>
                  {workspaceDataStatus === "loading" && <p role="status">Loading workspace data…</p>}
                  {workspaceDataStatus === "error" && <div role="alert">
                    <p>Workspace data could not be loaded. No totals are shown.</p>
                    <button type="button" className="secondary" onClick={() => void viewWorkspace(p.id)}>
                      Retry loading
                    </button>
                  </div>}
                  {workspaceDataStatus === "ready" && <>
                    <div className="metrics dashboard-metrics" aria-label="Workspace totals">
                      <div className="metric"><strong>{workspaceCandidates.length}</strong><span>Saved candidates</span></div>
                      <div className="metric"><strong>{workspaceCandidates.filter(c => c.status === "REVIEW_PENDING").length}</strong><span>Pending review</span></div>
                      <div className="metric"><strong>{workspaceDrafts.length}</strong><span>Saved draft emails</span></div>
                    </div>
                    <h3>Next steps</h3>
                    <ol className="getting-started">
                      <li><strong>Configure AI search</strong>
                        <p>{readiness.ready
                          ? "AI web research is available for your current model and application budget."
                          : "Complete the AI key, application budget and server readiness checks."}</p>
                        <button type="button" className="secondary" onClick={() => setPartnerTab("settings")}>
                          {readiness.ready ? "Review AI settings" : "Configure AI settings"}
                        </button>
                      </li>
                      <li><strong>Find and save experts</strong>
                        <p>Search public sources and save selected candidates together. Their contact details remain unverified.</p>
                        <button type="button" className="secondary" onClick={() => setPartnerTab("discovery")}>Open Research</button>
                      </li>
                      <li><strong>Review your candidates</strong>
                        <p>Check source evidence before approving any future outreach.</p>
                        <button type="button" className="secondary" onClick={() => setPartnerTab("candidates")}>Open Candidates</button>
                      </li>
                    </ol>
                  </>}
                  <div className="campaign-overview">
                    <h3>Research campaigns</h3>
                    <p className="muted">Plan a 100-candidate research test using your
                      own AI provider. A plan costs nothing; each manually approved
                      work unit can generate a paid provider call. Results are
                      <strong> unverified expert candidates</strong>, not usable email contacts.
                      Nothing runs automatically and no invitations are sent.</p>
                    <div className="form-grid">
                      <label>100-candidate search criteria
                        <textarea rows={2} minLength={12} maxLength={240}
                          disabled={campaignTestBusy} value={campaignTestQuery}
                          onChange={event => {
                            setCampaignTestQuery(event.target.value);
                            campaignCreateIdempotency.current = null;
                          }} />
                      </label>
                      <button type="button" disabled={campaignTestBusy ||
                        campaignTestQuery.trim().length < 12}
                        onClick={() => void createManualTestCampaign(p.id)}>
                        Plan 100-candidate test (free)
                      </button>
                    </div>
                    {campaignTestNotice && <p role="status">{campaignTestNotice}</p>}
                    {campaignListStatus === "error" && <p role="status">
                      Campaign status is unavailable. Candidate data remains accessible.
                    </p>}
                    {campaignListStatus === "ready" && (workspaceCampaigns.length
                      ? <ul>{workspaceCampaigns.map(item => <li key={item.id}>
                          <strong>{item.query}</strong> — {item.status.toLowerCase()}
                          <small>Campaign {item.id.slice(-6)} ·
                            Created {new Date(item.createdAt).toLocaleString()}</small>
                          <small>{item.uniqueSourcedCandidates} unique cited candidates /
                            target {item.targetCount} · {item.plannedTasks} planned tasks ·
                            No automatic execution</small>
                          <button type="button" className="secondary"
                            disabled={campaignProgressStatus === "loading"}
                            onClick={() => void openCampaignProgress(p.id, item.id)}>
                            {campaignProgressId === item.id && campaignProgressStatus === "loading"
                              ? "Loading…" : "View progress"}
                          </button>
                        </li>)}</ul>
                      : <p className="muted">No research campaigns planned in this workspace.</p>)}
                    {campaignProgressId && <section className="review-panel"
                      aria-label="Campaign research progress" aria-live="polite">
                      <h4>Campaign progress</h4>
                      {campaignProgressStatus === "loading" && <p role="status">
                        Loading committed research progress…</p>}
                      {campaignProgressStatus === "error" && <p role="alert">
                        Progress could not be loaded.

                        <button type="button" className="secondary"
                          onClick={() => void openCampaignProgress(p.id, campaignProgressId)}>
                          Retry</button></p>}
                      {campaignProgressStatus === "ready" && campaignProgress && <>
                        <p><strong>{campaignProgress.uniqueSourcedCandidates}</strong> unique
                          cited candidates / target {campaignProgress.targetCount}</p>
                        <progress aria-label="Sourced candidate target progress"
                          max={campaignProgress.targetCount}
                          value={Math.min(campaignProgress.uniqueSourcedCandidates,
                            campaignProgress.targetCount)}/>
                        <p>Operational status: <strong>{campaignProgress.operationalState}</strong></p>
                        {campaignEmailTriage && <section
                          className="campaign-email-triage"
                          data-state={campaignEmailTriage.status}
                          aria-label="Stored public email inspection results">
                          <div className="campaign-stage-header">
                            <strong>Public email evidence agent</strong>
                            <span className="campaign-stage-state">
                              {campaignEmailTriage.status.replaceAll("_", " ")}
                            </span>
                          </div>
                          <p className="muted">This is an independent, bounded, read-only
                            profile inspection. It does not call Gemini, verify mailboxes,
                            create workspace contacts or send outreach.</p>
                          <p role="status">
                            <strong>{campaignEmailTriage.reviewRequired}</strong> named email
                            observations requiring review ·
                            {" "}{campaignEmailTriage.noEmail} no attributable email ·
                            {" "}{campaignEmailTriage.blocked} blocked/ambiguous ·
                            {" "}{campaignEmailTriage.checking} inspecting ·
                            {" "}{campaignEmailTriage.remaining} remaining
                          </p>
                          {campaignEmailTriage.status === "RUNNING" &&
                            <button type="button" className="secondary"
                              disabled={campaignTriageBusy}
                              onClick={() => void changeCampaignEmailTriage(
                                p.id, campaignProgress.id, "stop")}>
                              Stop future inspections
                            </button>}
                          {campaignEmailTriage.status === "IDLE" &&
                            campaignEmailTriage.enabled &&
                            ["COMPLETED", "PARTIAL"].includes(campaignProgress.status) &&
                            campaignProgress.uniqueSourcedCandidates > 0 &&
                            campaignProgress.uniqueSourcedCandidates <= 250 && <>
                              <label className="campaign-contact-confirm">
                                <input type="checkbox"
                                  checked={campaignTriageConfirmed}
                                  onChange={event => setCampaignTriageConfirmed(event.target.checked)}/>
                                I authorize a single bounded inspection of up to
                                {" "}{campaignProgress.uniqueSourcedCandidates} saved public
                                profile URLs (24-hour approval, no paid AI calls,
                                no automatic retry after an uncertain inspection).
                              </label>
                              <button type="button"
                                disabled={!campaignTriageConfirmed || campaignTriageBusy}
                                onClick={() => void changeCampaignEmailTriage(
                                  p.id, campaignProgress.id, "start")}>
                                {campaignTriageBusy ? "Approving…" : "Inspect saved public profiles"}
                              </button>
                            </>}
                          {campaignEmailTriage.status === "IDLE" &&
                            !campaignEmailTriage.enabled &&
                            <p className="muted">Automated profile inspection is
                              not enabled on this server.</p>}
                          {campaignEmailTriage.status === "PAUSED" &&
                            <p role="status">Inspection is paused. A previously
                              attempted source will not be retried automatically.</p>}
                          {campaignTriageNotice && <p role="status">{campaignTriageNotice}</p>}
                        </section>}
                        <section className="campaign-stage-timeline"
                          aria-label="Live campaign stages">
                          <div className="campaign-stage-header">
                            <strong>Agent pipeline</strong>
                            <small>{campaignProgressLastSeen
                              ? "Last server update " +
                                new Date(campaignProgressLastSeen).toLocaleTimeString()
                              : "Waiting for a saved server snapshot"}
                              {" · "}Auto-refresh every 6 seconds</small>
                          </div>
                          {campaignProgressLiveWarning &&
                            <p role="status">Live status temporarily unavailable.
                              The last confirmed snapshot is shown; this view
                              does not start another research request.</p>}
                          <ol className="campaign-stage-steps">
                            {campaignStageTimeline(campaignProgress).map((stage, stageIndex) =>
                              <li key={stage.key} data-stage-state={stage.status}
                                aria-current={stage.status === "ACTIVE" ? "step" : undefined}>
                                <span className="campaign-stage-marker"
                                  aria-hidden="true">{stageIndex + 1}</span>
                                <div>
                                  <strong>{stage.title}</strong>
                                  <span className="campaign-stage-state">
                                    {stage.status.replaceAll("_", " ").toLowerCase()}
                                  </span>
                                  <p>{stage.detail}</p>
                                </div>
                              </li>)}
                          </ol>
                        </section>
                        {campaignRunApproval?.run && <section
                          className="campaign-approved-run" aria-label="Approved campaign automation">
                          <strong>Approved single-run budget</strong>
                          <p>Status: <strong>{campaignRunApproval.run.status}</strong>
                            {" · "}{campaignRunApproval.run.startedTasks} /
                            {campaignRunApproval.run.maxTasks} requests started
                            {" · "}Conservative ceiling committed:
                            {" $"}{(campaignRunApproval.run.committedWorstCaseCents / 100).toFixed(2)}
                            {" / $"}{(campaignRunApproval.run.maxWorstCaseCents / 100).toFixed(2)}</p>
                          <p>Approval expires:
                            {" "}{new Date(campaignRunApproval.run.expiresAt).toLocaleString()}.
                            Later calls are forbidden after this time.</p>
                          {campaignRunApproval.run.lastCode &&
                            <p role="status">Attention: {campaignRunApproval.run.lastCode.replaceAll("_", " ")}</p>}
                          {["APPROVED", "RUNNING"].includes(campaignRunApproval.run.status) &&
                            <button type="button" className="secondary"
                              disabled={campaignRunApprovalBusy}
                              onClick={() => void stopCampaignAutonomousRun(p.id, campaignProgress.id)}>
                              {campaignRunApprovalBusy ? "Stopping…" : "Stop future research requests"}
                            </button>}
                          <p className="muted">This is a conservative application budget,
                            not a verified provider invoice. A PAUSED run does not
                            automatically replay uncertain paid calls.</p>
                        </section>}
                        {campaignRunApproval?.autonomousRunEnabled &&
                          campaignRunApproval.priceEnvelope &&
                          !campaignRunApproval.run &&
                          campaignProgress.tasks.completed === 0 &&
                          campaignProgress.tasks.running === 0 &&
                          campaignProgress.uniqueSourcedCandidates === 0 &&
                          <section className="campaign-approved-run"
                            aria-label="Approve a one-launch campaign">
                            <strong>Start one server-managed campaign run</strong>
                            <p className="muted">Provider: {campaignRunApproval.priceEnvelope.provider}
                              {" · "}{campaignRunApproval.priceEnvelope.model}.
                              The worst-case reserve is
                              {" $"}{(campaignRunApproval.priceEnvelope.worstCasePerCallCents / 100).toFixed(2)}
                              per attempt. The worker stops at your approved limit,
                              any uncertain billing response, or an expired lease.
                              This does not search emails or send outreach.</p>
                            <label>Maximum paid research requests
                              <input type="number" min={1} max={24} step={1}
                                value={campaignMaxTasks}
                                disabled={campaignRunApprovalBusy}
                                onChange={event => setCampaignMaxTasks(
                                  Math.max(1, Math.min(24, Math.trunc(
                                    Number(event.target.value) || 1))))}/>
                            </label>
                            <p>Maximum conservative approved spend:
                              <strong>{" $"}{(campaignMaxTasks *
                                campaignRunApproval.priceEnvelope.worstCasePerCallCents / 100).toFixed(2)}</strong></p>
                            <label className="campaign-contact-confirm">
                              <input type="checkbox" checked={campaignNoReplayConfirmed}
                                onChange={event => setCampaignNoReplayConfirmed(event.target.checked)}/>
                              I approve this maximum reserve. I understand that uncertain
                              provider charges may consume the full reserve and will not
                              be automatically retried or refunded.
                            </label>
                            <button type="button"
                              disabled={!campaignNoReplayConfirmed || campaignRunApprovalBusy}
                              onClick={() => void approveCampaignAutonomousRun(
                                p.id, campaignProgress.id)}>
                              {campaignRunApprovalBusy ? "Saving approval…" : "Approve single run"}
                            </button>
                          </section>}
                        {campaignRunApprovalNotice && <p role="status">
                          {campaignRunApprovalNotice}</p>}
                        <p className="muted">Tasks: {campaignProgress.tasks.completed} complete ·
                          {campaignProgress.tasks.queued} queued ·
                          {campaignProgress.tasks.running} running ·
                          {campaignProgress.tasks.paused} paused ·
                          {campaignProgress.tasks.failed} failed</p>
                        <p className="muted">{campaignProgress.duplicateObservations} duplicate
                          research observations. These are discovery candidates,
                          not verified person-email contacts.</p>
                        {campaignProgress.needsReconciliation && <p role="alert">
                          Manual reconciliation required. Expired worker leases:
                          {" " + campaignProgress.expiredLeases}.
                          Do not restart paid research until the spend ledger is checked.</p>}
                        <p className="muted">Next step: {campaignProgress.action}.
                          No email checks or messages were sent by this view.</p>
                        {campaignProgress.pausedTaskReview?.length === 1 &&
                          campaignProgress.tasks.running === 0 && <>
                            <p role="alert">Task #{campaignProgress.pausedTaskReview[0].taskIndex + 1}
                              {" "}was paused after a potentially billable provider call.
                              Its previous results are not source-verified. This
                              action permanently skips ONLY that task; the full
                              conservative app-side charge remains and may differ
                              from the provider invoice. No AI call is replayed.</p>
                            <label className="checkbox-review">
                              <input type="checkbox" checked={skipChargeConfirmed}
                                disabled={campaignTestBusy}
                                onChange={event =>
                                  setSkipChargeConfirmed(event.target.checked)}/>
                              I reviewed the provider billing uncertainty,
                              accept the existing conservative charge without
                              a refund, and explicitly authorize skipping this
                              task without a retry.
                            </label>
                            <button type="button" disabled={campaignTestBusy ||
                              !skipChargeConfirmed}
                              onClick={() => void skipUncertainCampaignTask(p.id,
                                campaignProgress.id,
                                campaignProgress.pausedTaskReview[0].taskIndex)}>
                              Skip uncertain task without replay
                            </button>
                          </>}
                        {campaignProgress.operationalState === "READY" && <>
                          <p>Personal AI key: {personalAi.keyConfigured ? "configured" : "missing"} ·
                            {describeCampaignBudget(researchBudget,
                              personalAi.keyConfigured).message} ·
                            Daily research attempt limit: {researchLimits.dailyLimit}
                            (shared across manual and campaign research).</p>
                          <p className="muted">One campaign run continues through
                            the remaining {campaignProgress.tasks.queued} queued tasks
                            (maximum 24), until 100 cited candidates are found,
                            the plan is exhausted, or a safety gate stops it.
                            Start intervals are paced to respect the API limit.
                            Leave this browser tab open while the run is active.</p>
                          <p className="muted">Each task can incur a separate
                            provider charge. The app currently reserves a
                            conservative pricing ceiling; this is not the
                            actual Gemini invoice. Workspace permissions, spend
                            and daily quota are rechecked before each task.</p>
                          <label className="checkbox-review">
                            <input type="checkbox" checked={campaignPaidConfirmed}
                              disabled={campaignTestBusy}
                              onChange={event => setCampaignPaidConfirmed(event.target.checked)}/>
                            I authorize this single campaign run for up to
                            {Math.min(24, campaignProgress.tasks.queued)} paid AI research
                            tasks, within my configured limits. I will keep the
                            browser tab open, and stopping waits for the current task.
                          </label>
                          <button type="button" disabled={campaignTestBusy ||
                            !campaignPaidConfirmed || !personalAi.keyConfigured ||
                            !researchBudget.enforcedForPaidSearch ||
                            researchBudget.monthlyLimitCents == null ||
                            researchBudget.reconciliation?.needsReview === true ||
                            budgetStatus !== "ready" || personalAiStatus !== "ready"}
                            onClick={() => void executeManualCampaignTask(p.id, campaignProgress.id)}>
                            Run campaign until target or safety stop
                          </button>
                          {campaignTestBusy && <button type="button" className="secondary"
                            disabled={batchStopRequested.current}
                            onClick={() => {
                              batchStopRequested.current = true;
                              setCampaignTestNotice("Stop requested. Current paid task may finish; no further task will start.");
                            }}>
                            Stop run after current task ({campaignBatchCompleted} complete)
                          </button>}
                          {(budgetStatus !== "ready" || personalAiStatus !== "ready") &&
                            <p className="muted" role="status">Research budget or AI key
                              status is loading or unavailable. Refresh Settings
                              before initiating a paid call.</p>}
                          {budgetStatus === "ready" && personalAiStatus === "ready" &&
                            describeCampaignBudget(researchBudget,
                              personalAi.keyConfigured).code !== "READY" &&
                            <p role="status">Action required: {describeCampaignBudget(
                              researchBudget, personalAi.keyConfigured).message}
                              {" "}Review your application budget and spend ledger in AI settings.
                              No automatic budget increase or refund is performed.</p>}
                        </>}
                        <section className="campaign-observations"
                          aria-label="Saved campaign findings">
                          <div className="campaign-observations-heading">
                            <div>
                              <h5>Saved research findings</h5>
                              <p className="muted">These are source-linked
                                research observations, not imported workspace contacts.
                                Public email evidence is independently reviewed; a
                                published address is not proof of send permission.</p>
                            </div>
                            <button type="button" className="secondary"
                              disabled={campaignObservationsStatus === "loading"}
                              onClick={() => void loadCampaignObservations(
                                p.id, campaignProgress.id)}>
                              {campaignObservationsStatus === "idle"
                                ? "View saved findings" : "Reload findings"}
                            </button>
                          </div>
                          {campaignObservationsStatus === "loading" &&
                            <p role="status">Loading saved findings…</p>}
                          {campaignObservationsStatus === "error" &&
                            <p role="alert">Unable to load findings. No research
                              request was started. Try again.</p>}
                          {campaignObservationsStatus !== "idle" && (
                            <p className="muted" role="status">
                              Showing {campaignObservations.length} of
                              {" "}{campaignProgress.uniqueSourcedCandidates} saved
                              observations · 0 verified contacts in this
                              research view · Email not checked</p>
                          )}
                          {campaignObservationsStatus === "ready" &&
                            campaignObservations.length === 0 &&
                            <p>No source-linked findings saved yet.</p>}
                          {campaignObservations.length > 0 && <ul className="campaign-observation-list">
                            {campaignObservations.map(item => <li key={item.id}>
                              <div className="campaign-observation-title">
                                <strong>{item.name}</strong>
                                <span className="campaign-unverified">Unverified</span>
                              </div>
                              <small>{item.category.replaceAll("_", " ")}
                                {" · "}{item.emailTriageStatus && item.emailTriageStatus !== "UNCHECKED"
                                  ? item.emailTriageStatus.replaceAll("_", " ").toLowerCase()
                                  : "Email not checked"}
                                {" · "}{new Date(item.observedAt).toLocaleString()}</small>
                              {item.emailTriageEmail && <p>
                                <strong>Public email evidence: </strong>
                                {item.emailTriageEmail} — human review required,
                                not a saved contact or permission to send.</p>}
                              {item.emailTriageCode && !item.emailTriageEmail &&
                                <p className="muted">Inspection:
                                  {" "}{item.emailTriageCode.replaceAll("_", " ")}.
                                  No contact created.</p>}
                              <p>{item.rationale}</p>
                              <a href={item.citationUrl} target="_blank"
                                rel="noopener noreferrer">View provider-cited source</a>
                              <div className="campaign-email-check">
                                <button type="button" className="secondary"
                                  disabled={campaignEmailInspectionBusy !== null}
                                  onClick={() => void inspectCampaignObservationEmail(
                                    p.id, campaignProgress.id, item.id)}>
                                  {campaignEmailInspectionBusy === item.id
                                    ? "Inspecting public profile…"
                                    : "Check for published person-email"}
                                </button>
                                {campaignEmailInspections[item.id] && <p role="status">
                                  {campaignEmailInspections[item.id].observedEmail
                                    ? <>Email found (human review required):
                                        <strong>{" "}{campaignEmailInspections[item.id].observedEmail}</strong>.
                                        This is not a saved contact.</>
                                    : <>No attributable person-email verified:
                                        {" "}{campaignEmailInspections[item.id].code.replaceAll("_", " ")}.
                                        No contact was created.</>}
                                </p>}
                                {campaignEmailInspectionError[item.id] &&
                                  <p role="alert">{campaignEmailInspectionError[item.id]}</p>}
                                {item.candidateId && <p role="status">
                                  Linked to the Contacts list for further review.
                                  No outreach is authorized.</p>}
                                {!item.candidateId &&
                                  campaignEmailInspections[item.id]?.observedEmail &&
                                  campaignEmailInspections[item.id]?.evidenceDigest && <>
                                    <label className="campaign-contact-confirm">
                                      <input type="checkbox" disabled={campaignContactSaveBusy !== null}
                                        checked={campaignContactConfirm[item.id] === true}
                                        onChange={event => setCampaignContactConfirm(current => ({
                                          ...current, [item.id]: event.target.checked,
                                        }))}/>
                                      I reviewed this exact named profile and published
                                      email. Save as a review-pending contact, without
                                      authorizing email delivery.
                                    </label>
                                    <button type="button" disabled={campaignContactSaveBusy !== null ||
                                      campaignContactConfirm[item.id] !== true}
                                      onClick={() => void saveReviewedCampaignContact(
                                        p.id, campaignProgress.id, item.id)}>
                                      {campaignContactSaveBusy === item.id
                                        ? "Saving reviewed contact…" : "Save contact for review"}
                                    </button>
                                  </>}
                                {campaignContactSaveNotice[item.id] &&
                                  <p role="status">{campaignContactSaveNotice[item.id]}</p>}
                              </div>
                            </li>)}
                          </ul>}
                          {campaignObservationsCursor &&
                            <button type="button" className="secondary"
                              disabled={campaignObservationsStatus === "loading"}
                              onClick={() => void loadCampaignObservations(
                                p.id, campaignProgress.id, campaignObservationsCursor)}>
                              Load more saved findings
                            </button>}
                        </section>
                        <section className="campaign-manual-sources"
                          aria-label="Add public research sources">
                          <h5>Add public source URLs</h5>
                          <p className="muted">Paste up to 25 public HTTPS profile or
                            company page URLs, one per line. These sources are
                            saved for a future evidence review stage. Saving does
                            not launch AI, inspect websites, create contacts or
                            authorize provider spending.</p>
                          <label>Public source URLs
                            <textarea rows={4} value={manualSourceDraft}
                              disabled={manualSourceBusy}
                              placeholder={"https://example.org/experts/jane\nhttps://company.example.org/team"}
                              onChange={event => setManualSourceDraft(event.target.value)}/>
                          </label>
                          <div className="campaign-source-actions">
                            <button type="button"
                              disabled={manualSourceBusy ||
                                !manualSourceDraft.trim()}
                              onClick={() => void queueManualCampaignSources(
                                p.id, campaignProgressId)}>
                              {manualSourceBusy ? "Saving sources…" : "Add to research queue"}
                            </button>
                            <button type="button" className="secondary"
                              disabled={manualSourceBusy || manualSourceStatus === "loading"}
                              onClick={() => void loadManualCampaignSources(
                                p.id, campaignProgressId)}>
                              {manualSourceStatus === "loading"
                                ? "Loading sources…" : "View queued sources"}
                            </button>
                          </div>
                          {manualSourceNotice && <p role="status">{manualSourceNotice}</p>}
                          {manualSourceStatus === "error" &&
                            <p role="alert">Saved source list unavailable. Try again.</p>}
                          {manualSourceStatus === "ready" &&
                            <p className="muted">{manualSources.length} saved source(s)
                              shown · Not inspected · No contacts created</p>}
                          {manualSourceStatus === "ready" && manualSources.length > 0 &&
                            <ul className="campaign-source-list">
                              {manualSources.map(source => <li key={source.id}>
                                <a href={source.normalizedUrl} target="_blank"
                                  rel="noopener noreferrer">{source.normalizedUrl}</a>
                                <small>{source.status.replaceAll("_", " ")}
                                  {" · "}Added {new Date(source.createdAt).toLocaleString()}</small>
                              </li>)}
                            </ul>}
                        </section>
                        <button type="button" className="secondary"
                          onClick={() => void openCampaignProgress(p.id, campaignProgressId)}>
                          Refresh progress</button>
                      </>}
                      <button type="button" className="secondary"
                        onClick={() => {
                          ++campaignProgressRequest.current;
                          ++campaignObservationsRequest.current;
                          setCampaignObservations([]);
                          setCampaignObservationsCursor(null);
                          setCampaignObservationsStatus("idle");
                          setCampaignEmailInspections({});
                          setCampaignEmailInspectionError({});
                          setCampaignEmailInspectionBusy(null);
                          setCampaignContactConfirm({});
                          setCampaignContactSaveNotice({});
                          setCampaignContactSaveBusy(null);
                          ++manualSourceRequest.current;
                          setManualSourceDraft("");
                          setManualSources([]);
                          setManualSourceStatus("idle");
                          setManualSourceNotice("");
                          setCampaignProgressLastSeen(null);
                          setCampaignProgressLiveWarning(false);
                          setCampaignRunApproval(null);
                          setCampaignRunApprovalNotice("");
                          setCampaignRunApprovalBusy(false);
                          setCampaignNoReplayConfirmed(false);
                          setCampaignEmailTriage(null);
                          setCampaignTriageConfirmed(false);
                          setCampaignTriageNotice("");
                          setCampaignTriageBusy(false);
                          setCampaignProgressId(null);
                          setCampaignProgress(null);
                          setCampaignProgressStatus("idle");
                        }}>Close</button>
                    </section>}
                  </div>
                </div>}
                {partnerTab === "discovery" && <>
                  <section aria-label="Manual expert lead" className="review-panel">
                    <h3>Add an expert manually</h3>
                    <p className="muted">Enter an expert name and the public page you reviewed.
                      This does not scan or fetch the source website, check permissions,
                      extract emails, qualify an expert or send any messages.
                      Restricted directories must be researched manually or with permission.
                      After saving, open an independent browser search or prepare a draft
                      research query without triggering an automated provider call.</p>
                    <form onSubmit={event => void saveManualSeed(p.id, event)}>
                      <label>Expert name
                        <input required minLength={2} maxLength={160} value={seedName}
                          onChange={event => setSeedName(event.target.value)}/>
                      </label>
                      <label>Field
                        <select value={seedCategory} onChange={event => setSeedCategory(event.target.value)}>
                          {categories.map(([value, title]) =>
                            <option key={value} value={value}>{title}</option>)}
                        </select>
                      </label>
                      <label>Source page URL (HTTPS)
                        <input type="url" required maxLength={2048} pattern="https://.*"
                          value={seedUrl} onChange={event => setSeedUrl(event.target.value)}
                          placeholder="https://example.org/experts/profile"/>
                      </label>
                      <button type="submit" disabled={seedSaving}>
                        {seedSaving ? "Saving…" : "Add to my workspace"}
                      </button>
                    </form>
                  </section>
                  <section aria-label="AI web research preview" className="review-panel">
                  <h3>Find experts with AI web search</h3>
                  <p className="muted">Describe the type of experts you need. Run a source-backed search,
                    then select candidates to save in your review queue. A single search supports up to
                    20 results. For 100-candidate discovery campaigns, use
                    Dashboard → Research campaigns. Campaign findings are not
                    automatically converted into reviewed Candidate records or
                    verified email contacts.</p>
                  <details className="research-technical-details">
                    <summary>Search limits and costs</summary>
                    <p className="muted">Paid public-web research with your selected
                    { " " + personalAi.provider + " " + personalAi.model } model.
                    Only explicitly priced models can run. Claude and OpenAI permit at most
                    three built-in web searches per request; Gemini 2.5 is billed by
                    grounded prompt, not by query count. Every call reserves a conservative
                    amount from your owner-wide application USD budget. Review-only:
                    no candidates are imported or contacted. Failed requests may still be charged.</p>
                  <p className="muted">Safety rate limit: at most 2 research requests
                    per 60 seconds, regardless of the saved daily attempt limit.
                    Wait at least one minute before another test to avoid HTTP 429.</p>
                  </details>
                  <section aria-label="Research setup checklist" className="research-readiness">
                    <div className="research-readiness-heading">
                      <h4>Ready to search?</h4>
                      <span className={readiness.ready ? "research-ready-label" : "research-pending-label"}>
                        {readiness.ready ? "Ready" : "Setup needed"}
                      </span>
                    </div>
                    <ol className="research-readiness-steps">
                      {readiness.steps.map(step => <li key={step.key}
                        className={"research-readiness-step " + step.state}>
                        <strong>{step.title}</strong>
                        <p className="muted">{step.description}</p>
                        {step.state === "action" && <button type="button"
                          className="secondary" onClick={() => setPartnerTab("settings")}>
                            Open AI settings
                          </button>}
                      </li>)}
                    </ol>
                    {!readiness.ready && <button type="button" className="secondary"
                      disabled={personalAiStatus === "loading" || budgetStatus === "loading" ||
                        researchLimitsStatus === "loading"}
                      onClick={() => void Promise.allSettled([
                        loadPersonalAiSettings(), loadResearchBudget(), loadResearchLimits(),
                      ])}>
                      Refresh search readiness
                    </button>}
                    {readiness.ready && <p className="muted">
                      This authorizes only a single bounded search request. Results require
                      manual review and no emails are sent.
                    </p>}
                  </section>
                  <form onSubmit={event => void runResearch(p.id, event)}>
                    <label>Research criteria
                      <input value={researchQuery} maxLength={350} minLength={12} required
                        onChange={event => setResearchQuery(event.target.value)}/>
                    </label>
                    <button type="submit" disabled={researchStatus === "loading" ||
                      !readiness.ready}>
                      {researchStatus === "loading" ? "Researching…" : "Search public web"}
                    </button>
                  </form>
                  {!readiness.ready && <p className="muted" role="status">
                    Paid AI search stays disabled until the server confirms it is available.
                    Adding credits directly to your AI provider does not configure this application.
                  </p>}
                  {researchStatus === "error" && <>
                    <p role="alert">{researchError}</p>
                    <p className="muted">An unsuccessful provider request may still have
                      reserved application budget. Review the refreshed budget
                      before retrying.</p>
                  </>}
                  {researchResult && <>
                    <p className="muted">{researchResult.candidates.length} evidence-linked candidates for manual review
                      from {researchResult.provider} ({researchResult.model}).
                      Web requests: {researchResult.usage.searchRequests ?? "unknown"}.
                      Remaining requests today: {researchResult.quota.remaining.userWorkspace}
                      personal / {researchResult.quota.remaining.workspace} workspace.
                      Saving candidates requires explicit source review and does not authorize outreach.</p>
                    {researchResult.warnings.map(message => <p key={message} className="muted">{message}</p>)}
                    {researchResult.publicBusinessContacts && <>
                      <p className="muted">Public business inbox observations:
                        {researchResult.publicBusinessContacts.length}.
                        These contacts are not verified as belonging to any
                        specific expert. Review the source before using one.</p>
                      <ul>{researchResult.publicBusinessContacts.map(contact =>
                        <li key={contact.sourceUrl + contact.observedEmail}>
                          <strong>{contact.observedEmail}</strong> — Review required
                          <p>Business inbox observed on a cited page;
                            identity and contact permission are not verified.</p>
                          <a href={contact.sourceUrl} target="_blank" rel="noopener noreferrer">
                            Inspected public source</a>
                        </li>)}</ul>
                    </>}
                    {researchResult.contactAssociations?.length ? <>
                      <h4>Source associations (unverified)</h4>
                      <ul>{researchResult.contactAssociations.map(association =>
                        <li key={association.sourceUrl + association.observedEmail}>
                          <strong>{association.observedEmail}</strong> — {
                            association.relationship === "SHARED_SOURCE_AMBIGUOUS"
                              ? "Shared page: multiple people, attribution ambiguous"
                              : "Same cited page only; no person-level verification"
                          }
                          <p>Cited people: {association.candidateNames.join(", ") || "unknown"}.
                            Organization, individual identity and permission are unverified.</p>
                        </li>)}</ul>
                    </> : null}
                    {researchResult.profileObservations?.length ? <>
                      <h4>Expert name observations on inspected sources</h4>
                      <ul>{researchResult.profileObservations.map(profile =>
                        <li key={profile.sourceUrl + profile.name}>
                          <strong>{profile.name}</strong> — {
                            profile.observation === "EXACT_NAME_ON_INSPECTED_SOURCE"
                              ? "Full name observed on cited page; identity and affiliation not verified"
                              : "Name not observed in inspected page"
                          }
                        </li>)}</ul>
                    </> : null}
                    {researchResult.identityCollisions?.length ? <>
                      <h4>Possible namesakes — manual identity review</h4>
                      <ul>{researchResult.identityCollisions.map(collision =>
                        <li key={collision.name}>
                          <strong>{collision.name}</strong> appears across {
                            collision.sourceUrls.length} cited pages.
                          These records have not been automatically merged.
                        </li>)}</ul>
                    </> : null}
                    {researchResult.evidenceReviewOrder?.length ? <>
                      <h4>Evidence review priority (not an expertise score)</h4>
                      <ol>{researchResult.evidenceReviewOrder.map(item =>
                        <li key={item.sourceUrl + item.name}>
                          <strong>{item.name}</strong> — {
                            item.evidenceLevel === "PUBLIC_SOURCE_WITH_UNVERIFIED_BUSINESS_INBOX"
                              ? "Public business inbox found, person not verified"
                              : item.evidenceLevel === "PUBLIC_SOURCE_INSPECTED_NO_CONTACT"
                              ? "Public source inspected, no confirmed contact"
                              : "Provider citation only"
                          }
                        </li>)}</ol>
                    </> : null}
                    <div className="review-batch-actions">
                      <label className="checkbox-review">
                        <input type="checkbox"
                          checked={researchResult.candidates.length > 0 &&
                            researchResult.candidates.every(item =>
                              selectedResearchCandidates.includes(reviewedCandidateKey(item)) ||
                              savedResearchCandidates.includes(reviewedCandidateKey(item)))}
                          disabled={savingResearchCandidate !== null}
                          onChange={event => setSelectedResearchCandidates(event.target.checked
                            ? researchResult.candidates.map(reviewedCandidateKey) : [])}/>
                        <span>Select all discovered candidates</span>
                      </label>
                      <button type="button"
                        disabled={savingResearchCandidate !== null ||
                          selectedDiscoverySeedBatch(researchResult.candidates,
                            selectedResearchCandidates, savedResearchCandidates).length === 0}
                        onClick={() => void saveReviewedResearchCandidates(p.id)}>
                        {savingResearchCandidate === "__batch__" ? "Saving selected candidates…" :
                          "Save selected to review queue (" + selectedDiscoverySeedBatch(
                            researchResult.candidates, selectedResearchCandidates,
                            savedResearchCandidates).length + ")"}
                      </button>
                      <p className="muted">You can queue candidates without opening every profile.
                        Source links and observed emails are unverified; queueing never approves
                        identities, contact permission or outreach.</p>
                    </div>
                    <ul>{researchResult.candidates.map(item => {
                      const reviewKey = reviewedCandidateKey(item);
                      const reviewed = reviewedResearchSources.includes(reviewKey);
                      const saved = savedResearchCandidates.includes(reviewKey);
                      const selected = selectedResearchCandidates.includes(reviewKey);
                      return <li key={reviewKey}>
                        <label className="checkbox-review">
                          <input type="checkbox" checked={selected || saved}
                            disabled={saved || savingResearchCandidate !== null}
                            onChange={event => setSelectedResearchCandidates(prev =>
                              event.target.checked ? [...new Set([...prev, reviewKey])] :
                                prev.filter(key => key !== reviewKey))}/>
                          <span>{saved ? "In review queue" : "Include in review queue"}</span>
                        </label>
                        <strong>{item.name}</strong> — {item.category}
                        <p>{item.rationale}</p>
                        <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                          Provider-cited source (open to review)</a>
                        <label className="muted">Reviewed public profile URL (HTTPS)
                          <input type="url" required maxLength={2048}
                            placeholder="https://actual-expert-website.example/profile"
                            value={reviewedResearchUrls[reviewKey] ?? (
                              item.sourceUrl.includes("vertexaisearch.cloud.google.com/grounding-api-redirect/")
                                ? "" : item.sourceUrl)}
                            disabled={saved || savingResearchCandidate === reviewKey}
                            onChange={e => {
                              setReviewedResearchUrls(prev => ({
                                ...prev, [reviewKey]: e.target.value,
                              }));
                              setReviewedResearchSources(prev =>
                                prev.filter(key => key !== reviewKey));
                            }}/>
                          {item.sourceUrl.includes("vertexaisearch.cloud.google.com/grounding-api-redirect/")
                            ? "Gemini provided a redirect citation. Open it and copy the final website URL here."
                            : "Confirm this is the page you independently reviewed."}
                        </label>
                        <label className="muted">
                          <input type="checkbox" checked={reviewed}
                            disabled={saved || savingResearchCandidate === reviewKey}
                            onChange={e => setReviewedResearchSources(prev =>
                              e.target.checked ? [...prev, reviewKey] :
                                prev.filter(key => key !== reviewKey))}/>
                          I independently reviewed this public source. The person's
                          identity and contact information are not yet verified.
                        </label>
                        <button type="button" className="secondary"
                          disabled={!reviewed || saved || savingResearchCandidate !== null ||
                            !resolvedReviewedSource(item, reviewedResearchUrls)}
                          onClick={() => void saveReviewedResearchCandidates(p.id, reviewKey)}>
                          {saved ? "Saved to candidates" :
                            savingResearchCandidate === reviewKey ? "Saving…" :
                            "Save to workspace for review"}
                        </button>
                      </li>;
                    })}</ul>
                  </>}
                </section></>}
                {(partnerTab === "candidates" || partnerTab === "drafts") && <>
                <h3>My candidates and outreach drafts</h3>
                <p className="muted">Workspace-isolated candidate review. Public person-email
                  associations require explicit source inspection and confirmation. No
                  automatic outreach or email sending is enabled.</p>
                {workspaceDataStatus === "loading" && <p>Loading workspace data…</p>}
                {workspaceDataStatus === "error" && <div role="alert">
                  Workspace data could not be loaded.
                  <button type="button" className="secondary" onClick={() => void viewWorkspace(p.id)}>
                    Retry
                  </button>
                </div>}
                {workspaceDataStatus === "ready" && <>
                  <div className="metrics">
                    <div className="metric"><strong>{workspaceCandidates.length}</strong><span>Total candidates</span></div>
                    <div className="metric"><strong>{workspaceCandidates.filter(c => c.qualification.qualified).length}</strong><span>Qualified experts</span></div>
                    <div className="metric"><strong>{workspaceDrafts.length}</strong><span>Saved drafts</span></div>
                    <div className="metric"><strong>{workspaceCandidates.filter(c =>
                      c.contactVerification?.usableAsContact === true).length}</strong><span>Verified usable contacts</span></div>
                  </div>
                  {partnerTab === "candidates" && <>
                    <h3>Candidate pipeline</h3>
                    <p className="muted">Candidate count is not contact count. An email is usable only
                      after the exact person–email association is reviewed AND the mailbox
                      has a valid technical verification. Neither proves consent to send.</p>
                    <div className="metrics" aria-label="Contact evidence funnel">
                      <div className="metric"><strong>{workspaceCandidates.filter(c =>
                        c.contactVerification?.personEmail === "REVIEWED").length}</strong><span>Person-email links reviewed</span></div>
                      <div className="metric"><strong>{workspaceCandidates.filter(c =>
                        c.contactVerification?.mailbox === "VALID").length}</strong><span>Mailboxes vendor-valid</span></div>
                      <div className="metric"><strong>{workspaceCandidates.filter(c =>
                        c.contactVerification?.usableAsContact === true).length}</strong><span>Usable contacts</span></div>
                    </div>
                    <div className="table-scroll candidate-pipeline-scroll"><table className="candidate-pipeline-table"><thead><tr>
                      <th>Candidate</th><th>Category</th><th>Region</th>
                      <th>Person-email</th><th>Mailbox</th><th>Next action</th><th>Review</th>
                    </tr></thead><tbody>
                      {workspaceCandidates.map(c => <tr key={c.id}>
                        <td data-label="Candidate"><strong>{c.name}</strong><small>{c.email ?? "No email"}</small></td>
                        <td data-label="Category">{categories.find(x => x[0] === c.category)?.[1] ?? c.category}</td>
                        <td data-label="Region">{c.region ?? "Unconfirmed"}</td>
                        <td data-label="Person-email">{c.contactVerification?.personEmail === "REVIEWED"
                          ? "Exact link reviewed" : c.contactVerification?.personEmail === "REVIEW_REQUIRED"
                          ? "Evidence awaiting review" : "No verified link"}</td>
                        <td data-label="Mailbox">{c.contactVerification?.mailbox === "VALID" ? "Provider valid" :
                          c.contactVerification?.mailbox === "INVALID" ? "Invalid" :
                          c.contactVerification?.mailbox === "RISKY" ? "Risky" : "Not confirmed"}</td>
                        <td data-label="Next action"><strong>{stageNames[c.qualification.stage] ?? c.qualification.stage}</strong>
                          {c.outreach.blockers.length > 0 && <small>{c.outreach.blockers.map(r =>
                            reasonNames[r] ?? r).join(" · ")}</small>}</td>
                        <td data-label="Review" className="candidate-pipeline-actions">
                          {c.expertProfileUrl && <button type="button" className="secondary"
                            disabled={busy || personEmailBusy}
                            onClick={() => void inspectCandidatePersonEmail(p.id, c.id)}>
                            Inspect named email
                          </button>}
                          <button type="button" className="secondary" disabled={busy}
                            onClick={() => void openPartnerEvidence(p.id, c.id)}>Evidence</button>
                          <button type="button" className="secondary" disabled={busy}
                            onClick={() => openIndependentManualSearch(c)}>Search independently</button>
                          <button type="button" className="secondary" disabled={busy}
                            onClick={() => prepareIndependentResearch(c)}>Prepare AI criteria</button>
                          {c.discoveryKey && <button type="button" className="secondary"
                            disabled={busy || partnerReviewSaving} onClick={() => beginProfileReview(c)}>
                            {c.expertProfileUrl ? "Review profile" : "Set expert profile"}
                          </button>}
                          {!c.expertProfileUrl && <small className="candidate-pipeline-hint">
                            Add a verified individual profile URL before inspecting named email.
                          </small>}
                        </td>
                      </tr>)}
                      {!workspaceCandidates.length && <tr><td colSpan={7} className="empty">No candidates in this workspace.</td></tr>}
                    </tbody></table></div>
                    {personEmailCandidateId && <section className="review-panel"
                      aria-label="Direct person-email evidence review">
                      <h3>Review public person-email evidence</h3>
                      <p className="muted">The server inspects only the candidate's saved public
                        individual profile. A discovered address is never automatically
                        approved, and no message is sent.</p>
                      {personEmailBusy && <p role="status">Checking person-email evidence…</p>}
                      {personEmailEvidence?.observation && <>
                        <p>Candidate: <strong>{workspaceCandidates.find(c =>
                          c.id === personEmailCandidateId)?.name ?? "Selected candidate"}</strong></p>
                        <p>Publicly observed address: <strong>{
                          personEmailEvidence.observation.observedEmail}</strong></p>
                        <p><a href={personEmailEvidence.observation.sourceUrl}
                          target="_blank" rel="noopener noreferrer">
                          Open independently inspected profile</a></p>
                        <p className="muted">Evidence status: {personEmailEvidence.observation.status}.
                          A positive mailbox check, legal review and suppression check
                          are still required independently.</p>
                        {personEmailEvidence.observation.reviewRequired && <>
                          <label className="checkbox-review">
                            <input type="checkbox" checked={personEmailConfirmed}
                              disabled={personEmailBusy} onChange={event =>
                                setPersonEmailConfirmed(event.target.checked)} />
                            I checked this public profile and confirm this exact
                            person owns the displayed professional email
                          </label>
                          <button type="button"
                            disabled={!personEmailConfirmed || personEmailBusy}
                            onClick={() => void approveCandidatePersonEmail(p.id)}>
                            Confirm exact person-email link
                          </button>
                        </>}
                      </>}
                      {!personEmailBusy && !personEmailEvidence?.observation &&
                        <p className="muted">No reviewable direct email evidence is available.
                          Check the candidate's individual profile and try inspection again.</p>}
                      <button type="button" className="secondary"
                        disabled={personEmailBusy} onClick={() => {
                          ++personEmailRequest.current;
                          setPersonEmailCandidateId(null);
                          setPersonEmailEvidence(null);
                          setPersonEmailConfirmed(false);
                        }}>Close</button>
                    </section>}
                    {reviewId && <form className="form-grid review-panel"
                      aria-label="Partner expert profile review"
                      onSubmit={event => void savePartnerProfileReview(p.id, event)}>
                      <h3 className="wide">Verify an independently sourced expert profile</h3>
                      <p className="wide muted">Check the expert's independent profile. A blog byline is not
                        evidence of online consulting, contact permission or outreach eligibility.</p>
                      <label className="wide">Expert profile URL (not the article URL)
                        <input type="url" required maxLength={2048} value={reviewProfileUrl}
                          onChange={event => setReviewProfileUrl(event.target.value)} />
                      </label>
                      <label>Verified region
                        <select value={reviewRegion} onChange={event => setReviewRegion(event.target.value)}>
                          <option value="">Not confirmed</option>
                          {regions.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                        </select>
                      </label>
                      <label className="checkbox-review"><input type="checkbox" checked={reviewEnglish}
                        onChange={event => setReviewEnglish(event.target.checked)} />
                        English online consultations explicitly confirmed
                      </label>
                      <button type="submit" disabled={partnerReviewSaving}>
                        {partnerReviewSaving ? "Saving…" : "Save manual review"}
                      </button>
                      <button type="button" className="secondary" disabled={partnerReviewSaving}
                        onClick={() => {
                          ++partnerReviewRequest.current;
                          setReviewId(null);
                        }}>Cancel</button>
                    </form>}
                    {partnerEvidenceId && <section className="review-panel" aria-label="Partner source evidence">
                      <h3>Candidate source evidence</h3>
                      <p className="muted">Review original source links. Evidence does not establish contact consent or authorize sending.</p>
                      {partnerEvidenceState === "loading" && <p>Loading source evidence…</p>}
                      {partnerEvidenceState === "error" && <div role="alert">
                        Could not load source evidence.
                        <button type="button" className="secondary" onClick={() =>
                          void openPartnerEvidence(p.id, partnerEvidenceId)}>Retry</button>
                      </div>}
                      {partnerEvidenceState === "ready" && <>
                        {partnerEvidenceRows.length === 0 && <p className="muted">No evidence recorded for this candidate.</p>}
                        <ul>{partnerEvidenceRows.map(item => <li key={item.id}>
                          <strong>{item.kind}</strong> · <a href={item.sourceUrl}
                            target="_blank" rel="noopener noreferrer">Source link</a>
                          {item.note && <small>{item.note}</small>}
                        </li>)}</ul>
                        <form className="form-grid" onSubmit={event => void savePartnerEvidence(p.id, event)}>
                          <label>Evidence type<select value={partnerEvidenceKind} onChange={event =>
                            setPartnerEvidenceKind(event.target.value)}>
                            {["ARTICLE", "PROFILE", "SERVICE", "OTHER"].map(kind =>
                              <option key={kind} value={kind}>{kind}</option>)}
                          </select></label>
                          <label className="wide">Source URL<input type="url" required maxLength={2048}
                            value={partnerEvidenceUrl} onChange={event =>
                              setPartnerEvidenceUrl(event.target.value)}/></label>
                          <label className="wide">Review note (optional)<input maxLength={500}
                            value={partnerEvidenceNote} onChange={event =>
                              setPartnerEvidenceNote(event.target.value)}/></label>
                          <button type="submit" disabled={partnerEvidenceSaving}>
                            {partnerEvidenceSaving ? "Saving…" : "Save source evidence"}
                          </button>
                        </form>
                      </>}
                      <button type="button" className="secondary" onClick={() => {
                        ++partnerEvidenceRequest.current;
                        setPartnerEvidenceId(null);
                        setPartnerEvidenceRows([]);
                        setPartnerEvidenceState("idle");
                      }}>Close</button>
                    </section>}
                  </>}
                  {partnerTab === "drafts" && <>
                    <h3>Outreach drafts</h3>
                    <div className="table-scroll"><table><thead><tr>
                      <th>Candidate</th><th>Subject</th><th>Provider</th>
                    </tr></thead><tbody>
                      {workspaceDrafts.map(d => <tr key={d.id}>
                        <td>{d.candidate.name}</td><td>{d.subject}</td><td>{d.provider}</td>
                      </tr>)}
                      {!workspaceDrafts.length && <tr><td colSpan={3} className="empty">No saved drafts in this workspace.</td></tr>}
                    </tbody></table></div>
                  </>}
                </>}
                </>}
              </section>}
            {connectionStatus === "loading" ? <p className="muted">Checking Google connection…</p>
              : connectionStatus === "unavailable" ? <p className="muted">Connection status unknown</p>
              : connection ? <>
                <p className="muted">Google access is authorized (read-only), but no specific
                  spreadsheet has been selected or synchronized into this workspace.
                  Contact and outreach data remain in the application database.</p>
                <button className="secondary" disabled={busy}
                  onClick={() => disconnectGoogle(p.id)}>Disconnect Google</button>
              </> : !googleConfigured ? <p className="muted">Google connection is not configured for this environment.</p>
              : <>
                <p className="muted">Google Forms & Sheets: not connected</p>
                <a className="secondary" href={"/api/partner/google/connect/start?partnerId=" + encodeURIComponent(p.id)}>
                  Connect Google Forms & Sheets
                </a>
              </>}
          </div>;
        })}

        </section>}
        {partnerTab === "settings" && <section className="panel">
          <h2>Partner settings</h2>
          <p className="muted">Google Forms and Sheets consent is read-only. Synchronization is not active.</p>
        <section aria-label="Personal Gmail sending authorization">
          <h2>My Gmail sender</h2>
          <p className="muted">Gmail consent is optional and separate from Google login and Forms/Sheets.
            Connecting does not send any email. Sending remains disabled pending campaign approval and safety checks.</p>
          {gmailStatusError && <div role="alert">
            Gmail connection status is unavailable.
            <button type="button" className="secondary" onClick={() => void loadGmailStatus()}>
              Retry status
            </button>
          </div>}
          {!gmailStatusError && !gmailStatus && <p className="muted">Checking Gmail authorization…</p>}
          {gmailStatus?.connected && <>
            <p className="muted">Authorized Gmail account: {gmailStatus.email} · Sending disabled.</p>
            <button type="button" className="secondary" disabled={busy} onClick={() => void disconnectGmail()}>
              Disconnect Gmail
            </button>
          </>}
          {gmailStatus && !gmailStatus.connected && !gmailStatus.available &&
            <p className="muted">Gmail authorization is not enabled for this environment.</p>}
          {gmailStatus && !gmailStatus.connected && gmailStatus.available &&
            (partnerSession.partners?.length ?? 0) > 0 &&
            <a className="secondary" href={"/api/partner/google/gmail/start?workspaceId=" +
              encodeURIComponent(partnerSession.partners![0].id)}>
              Authorize my Gmail sender
            </a>}
        </section>
        <section aria-label="Personal AI configuration">
          <h2>My AI provider</h2>
          <p className="muted">Use your own AI API key. Keys are encrypted, never shared
            with other users or with the legacy admin account. Provider usage and charges are yours.
            AI draft generation becomes available after the workspace workflow is enabled.</p>
          {personalAiStatus === "loading" ? <p className="muted">Loading your AI settings…</p>
            : personalAiStatus === "error" ? <button className="secondary" type="button"
                onClick={() => void loadPersonalAiSettings()}>Retry AI settings</button>
            : <form onSubmit={savePersonalAiSettings}>
              <label>AI provider
                <select value={personalAi.provider} onChange={e => setPersonalAi({
                  ...personalAi, provider: e.target.value,
                  model: defaultAiModels[e.target.value] ?? personalAi.model,
                })}>
                  <option value="gemini">Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Claude (Anthropic)</option>
                </select>
              </label>
              <label>Model <input required value={personalAi.model}
                onChange={e => setPersonalAi({ ...personalAi, model: e.target.value })} /></label>
              <label>Personal API key <input type="password" autoComplete="off"
                value={personalApiKey} required={!personalAi.keyConfigured}
                onChange={e => setPersonalApiKey(e.target.value)}
                placeholder={personalAi.keyConfigured ? "Configured — enter to replace" : "Paste your provider key"} /></label>
              <p className="muted">{personalAi.keyConfigured
                ? "Key configured (fingerprint: " + (personalAi.fingerprint ?? "unavailable") + ")"
                : "No personal AI key configured."}</p>
              <button type="submit" disabled={busy}>Save my AI settings</button>
              {personalAi.keyConfigured && <button type="button" className="secondary" disabled={busy}
                onClick={() => void deletePersonalAiSettings()}>Remove my AI key</button>}
            </form>}
        </section>
        <section aria-label="Personal AI research limits" className="review-panel">
          <h2>My research limits</h2>
          <p className="muted">Your limits apply to your personal API key in each
            authorized workspace. Limits count attempts, including failed provider calls.
            This is not a monetary cap and does not guarantee a maximum provider bill.
            Paid web research is available for approved models only when a
            sufficient owner-wide application spending budget is configured.</p>
          {researchLimitsStatus === "loading" ? <p>Loading research limits…</p>
            : researchLimitsStatus === "error" ?
              <button type="button" className="secondary"
                onClick={() => void loadResearchLimits()}>Retry loading limits</button>
            : <form onSubmit={saveResearchLimits}>
              <label>Daily search attempts (1–100)
                <input type="number" required min={1} max={100} step={1}
                  value={researchLimits.dailyLimit}
                  onChange={e => setResearchLimits({ ...researchLimits,
                    dailyLimit: Number(e.target.value) })}/>
              </label>
              <label>Maximum candidates per search (1–20)
                <input type="number" required min={1} max={20} step={1}
                  value={researchLimits.maxCandidates}
                  onChange={e => setResearchLimits({ ...researchLimits,
                    maxCandidates: Number(e.target.value) })}/>
              </label>
              <label>Maximum simultaneous research runs (1–3)
                <input type="number" required min={1} max={3} step={1}
                  value={researchLimits.maxConcurrent}
                  onChange={e => setResearchLimits({ ...researchLimits,
                    maxConcurrent: Number(e.target.value) })}/>
              </label>
              <p className="muted">Server safety ceilings: 100 attempts per
                workspace/day and five concurrent workspace searches. Active-run
                slots recover automatically after process failures.
                Daily attempt limits and server-owned monetary reservations are active
                for approved exact models. Incomplete provider usage retains the
                full reserved amount; this does not cap external invoices.</p>
              <button type="submit" disabled={busy || !personalAi.keyConfigured}>
                Save my research limits
              </button>
            </form>}
        </section>
        <section aria-label="Personal AI monthly budget" className="review-panel">
          <h2>Monthly research budget</h2>
          <p className="muted">Required USD application spending limit for your personal API key across
            every workspace. Approved exact models are Claude Sonnet 4.6 (up to $4.00),
            OpenAI GPT-4.1 mini (up to $1.50) and Gemini 2.5 Flash (up to $2.00)
            per attempt; other models and tools remain blocked.
            The application ledger is conservative, not a provider invoice or external billing cap.</p>
          <p role="status">{researchBudget.enforcedForPaidSearch
            ? "Approved web research is enabled within your saved application budget."
            : "Web research is not yet available for this model, budget or environment."}</p>
          {budgetStatus === "loading" ? <p className="muted">Loading budget…</p>
            : budgetStatus === "error" ?
              <button type="button" className="secondary"
                onClick={() => void loadResearchBudget()}>Retry loading budget</button>
            : <form onSubmit={saveResearchBudget}>
              <label>Budget in USD per UTC month (1–1000)
                <input type="number" min={1} max={1000} step={1} required
                  value={researchBudget.monthlyLimitCents === null ? "" :
                    researchBudget.monthlyLimitCents / 100}
                  onChange={e => setResearchBudget({ ...researchBudget,
                    monthlyLimitCents: e.target.value === "" ? null :
                      Math.round(Number(e.target.value) * 100) })}/>
              </label>
              {researchBudget.ledger && <div aria-label="Research spend ledger" className="review-panel">
                <h3>Application spending ledger · {researchBudget.ledger.monthUtc.slice(0, 7)} UTC</h3>
                <p>Estimated settled: ${(researchBudget.ledger.settledCents / 100).toFixed(2)} USD
                  · Reserved: ${(researchBudget.ledger.reservedCents / 100).toFixed(2)} USD</p>
                <p>Pending reservations: {researchBudget.ledger.pendingReservations}
                  · Estimated remaining application budget: {researchBudget.ledger.availableCents === null ?
                    "Not configured" : (researchBudget.ledger.availableCents / 100).toFixed(2) + " USD"}</p>
                {researchBudget.reconciliation?.needsReview && <p role="status">
                  Manual reconciliation required: {researchBudget.reconciliation.staleReservations}
                  {" "}unresolved reservation(s) older than
                  {" "}{researchBudget.reconciliation.staleAfterMinutes} minutes, across UTC months.
                  Possible provider charges remain reserved. Contact an operator to
                  investigate; no automatic refund is performed.
                </p>}
                <p className="muted">These are conservative application estimates,
                  not verified provider charges. They do not cap your external provider invoice.
                  Uncertain usage retains its entire reserved amount.</p>
              </div>}
              <p className="muted">Provider invoices can differ from estimated usage.
                No guaranteed billing cap is offered until provider-side
                spending controls and our reservation contract are verified.</p>
              <button type="submit" disabled={busy || !personalAi.keyConfigured ||
                researchBudget.monthlyLimitCents === null}>Save budget preference</button>
            </form>}
        </section>

        </section>}
      </section>
    </main>
  );

  if (!loggedIn) return (
    <main className="login-shell">
      <form className="panel login" onSubmit={login}>
        <span className="eyebrow">SNAPYCALL • PILOT OUTREACH</span>
        <h1>Admin sign in</h1>
        <p className="muted">Private expert acquisition workspace. Outbound sending is disabled.</p>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" disabled={busy}>Sign in</button>
        <a className="secondary" href="/api/auth/google/start" style={{ textAlign: "center", padding: 12, borderRadius: 8 }}>Continue with Google (invited partners)</a>
      </form>
    </main>
  );

  return <main className="layout">
    <aside>
      <div className="brand">SNAPYCALL<span> / PILOT</span></div>
      <p className="sidebar-label">WORKSPACE</p>
      <nav aria-label="Workspace sections">
        {(["candidates", "discovery", "drafts", "settings"] as const).map((item) =>
          <button type="button" className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
            {item === "settings" ? "AI configuration" : item === "drafts" ? "Outreach drafts" : item === "discovery" ? "Free discovery" : "Candidates"}
          </button>)}
      </nav>
      <div className="sidebar-bottom">
        <span className="state">● Draft-only mode · Administrator session</span>
        <button type="button" className="ghost" disabled={busy} onClick={() => void switchToPartnerSignIn()}>
          Switch to Google partner sign-in
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={logout}>Sign out</button>
      </div>
    </aside>
    <section className="content">
      <header><div><span className="eyebrow">PILOT EXPERT ACQUISITION</span><h1>{tab === "candidates" ? "Expert candidates" : tab === "drafts" ? "Outreach drafts" : tab === "discovery" ? "Free lead discovery" : "Your AI provider"}</h1></div><span className="pill">No automatic sending</span></header>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success" role="status">{notice}</div>}
      {tab === "candidates" && <>
        <div className="metrics">
          <div className="metric"><strong>{candidates.length}</strong><span>Total candidates</span></div>
          <div className="metric"><strong>{candidates.filter(c => c.qualification.qualified).length}</strong><span>Qualified experts</span></div>
          <div className="metric"><strong>{drafts.length}</strong><span>Saved drafts</span></div>
        </div>
        <section className="panel">
          <h2>Add candidate</h2>
          <form className="form-grid" onSubmit={saveCandidate}>
            <label>Full name<input required maxLength={160} value={candidate.name} onChange={e => setCandidate({ ...candidate, name: e.target.value })} /></label>
            <label>Email (optional)<input type="email" maxLength={254} value={candidate.email} onChange={e => setCandidate({ ...candidate, email: e.target.value })} /></label>
            <label>Category<select value={candidate.category} onChange={e => setCandidate({ ...candidate, category: e.target.value })}>{categories.map(([v,l]) => <option value={v} key={v}>{l}</option>)}</select></label>
            <label>Region<select value={candidate.region} onChange={e => setCandidate({ ...candidate, region: e.target.value })}>{regions.map(([v,l]) => <option value={v} key={v}>{l}</option>)}</select></label>
            <label className="wide">Source profile URL<input type="url" required placeholder="https://..." value={candidate.sourceUrl} onChange={e => setCandidate({ ...candidate, sourceUrl: e.target.value })} /></label>
            <label>Legal basis note (optional)<input maxLength={120} value={candidate.legalBasis} onChange={e => setCandidate({ ...candidate, legalBasis: e.target.value })}/></label>
            <div className="checkboxes"><label><input type="checkbox" checked={candidate.onlineEnglish} onChange={e => setCandidate({ ...candidate, onlineEnglish: e.target.checked })}/> Online English sessions confirmed</label><label><input type="checkbox" checked={candidate.contactReviewed} onChange={e => setCandidate({ ...candidate, contactReviewed: e.target.checked })}/> Contact manually reviewed</label></div>
            <button disabled={busy}>Add candidate</button>
          </form>
        </section>
        <section className="panel"><h2>Candidate pipeline</h2><div className="table-scroll"><table><thead><tr><th>Candidate</th><th>Category</th><th>Region</th><th>Next action</th><th>Action</th></tr></thead><tbody>
          {candidates.map(c => <tr key={c.id}><td>
              <strong>{c.name}</strong><small>{c.email ?? "No email"}</small>
              <small>{c.sourceUrl ? <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {c.discoveryKey ? "Public source (unverified)" : "Source profile"}</a> :
                    "Durable public source pending review"}</small>
              {c.discoveryKey && <small>{c.profileReviewed && c.expertProfileUrl
                ? <a href={c.expertProfileUrl} target="_blank" rel="noopener noreferrer">Reviewed expert profile</a>
                : "Expert profile not reviewed"}</small>}
            </td><td>{categories.find(x => x[0] === c.category)?.[1] ?? c.category}</td>
            <td>{c.region ?? "Unconfirmed"}</td>
            <td><strong>{stageNames[c.qualification.stage] ?? c.qualification.stage}</strong>
              {c.outreach.blockers.length > 0 && <small>{c.outreach.blockers.map(r => reasonNames[r] ?? r).join(" · ")}</small>}</td>
            <td>
              <button type="button" className="secondary" disabled={busy} onClick={() => showEvidence(c.id)}>Evidence</button>
              {c.discoveryKey && <button type="button" className="secondary" disabled={busy} onClick={() => beginProfileReview(c)}>Review profile</button>}
              <button type="button" disabled={busy || !c.outreach.canDraft || !setting.keyConfigured} onClick={() => makeDraft(c.id)}>Generate draft</button>
            </td></tr>)}
          {!candidates.length && <tr><td colSpan={5} className="empty">No candidates yet. Add one above to start.</td></tr>}
        </tbody></table></div>
        {evidenceId && <section className="review-panel" aria-label="Candidate evidence">
          <h3>Source evidence</h3>
          <p className="muted">Keep articles and profiles as separate references. Adding a link does not automatically verify an identity, qualification or right to contact.</p>
          {duplicateHints.length > 0 && <div className="review-panel">
            <strong>Possible duplicate profiles — review only</strong>
            <p className="muted">A matching URL or email is not proof that two entries represent the same person. No records have been combined.</p>
            {duplicateHints.map(match => <p key={match.id}>
              Candidate {candidates.find(c => c.id === match.id)?.name ?? match.id}
              <small>{match.reasons.join(", ")}</small>
            </p>)}
          </div>}
          {duplicateScanIncomplete && <p className="hint">Duplicate check is incomplete because the review set exceeds the pilot search limit.</p>}
          {evidence.length ? <ul>{evidence.map(item => <li key={item.id}>
            <strong>{item.kind}</strong> · <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.sourceUrl}</a>
            {item.note && <small>{item.note}</small>}
          </li>)}</ul> : <p>No additional evidence recorded yet.</p>}
          <form className="form-grid" onSubmit={saveEvidence}>
            <label>Evidence type<select value={evidenceKind} onChange={e => setEvidenceKind(e.target.value)}>
              {["ARTICLE", "PROFILE", "SERVICE", "OTHER"].map(kind => <option key={kind} value={kind}>{kind}</option>)}
            </select></label>
            <label className="wide">Source URL<input required type="url" value={evidenceUrl}
              onChange={e => setEvidenceUrl(e.target.value)} placeholder="https://..." /></label>
            <label className="wide">Review note (optional)<input value={evidenceNote}
              onChange={e => setEvidenceNote(e.target.value)} maxLength={500} /></label>
            <button type="submit" disabled={busy}>Save evidence</button>
            <button type="button" className="secondary" onClick={() => setEvidenceId(null)}>Close</button>
          </form>
        </section>}
        {reviewId && <form className="form-grid review-panel" onSubmit={saveProfileReview}>
          <h3 className="wide">Verify an independently sourced expert profile</h3>
          <p className="wide muted">A blog byline is not evidence of an online consulting service. Check the linked profile yourself. Only attest English online sessions if the profile explicitly confirms them.</p>
          <label className="wide">Expert profile URL (not the article URL)
            <input type="url" required maxLength={2048} value={reviewProfileUrl}
              onChange={e => setReviewProfileUrl(e.target.value)} />
          </label>
          <label>Verified region
            <select value={reviewRegion} onChange={e => setReviewRegion(e.target.value)}>
              <option value="">Not confirmed</option>
              {regions.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
            </select>
          </label>
          <label className="checkbox-review"><input type="checkbox" checked={reviewEnglish}
            onChange={e => setReviewEnglish(e.target.checked)} />
            English online consultations explicitly confirmed
          </label>
          <button type="submit" disabled={busy}>Save manual review</button>
          <button type="button" className="secondary" onClick={() => setReviewId(null)}>Cancel</button>
        </form>}
      </section>
      </>}
      {tab === "discovery" && <section className="panel">
        <h2>Find prospective experts from free RSS / Atom sources</h2>
        <p className="muted">No paid discovery API, no LinkedIn scraping, no emails sent. Authors found in public feeds are unverified prospects. Review their original work before contacting anyone.</p>
        <div className="panel">
          <h2>Free manual web search</h2>
          <p className="muted">Search public professional websites without a paid API. Results open in your browser; add only reviewed candidates from permitted sources.</p>
          <label>Expert category<select value={discoveryCategory} onChange={e => setDiscoveryCategory(e.target.value)}>
            {categories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <div className="form-grid" style={{ marginTop: 14 }}>
            {(["US", "UK_IRELAND", "OTHER_ENGLISH_SPEAKING"] as const).map(region => {
              const terms: Record<string, string> = {
                AI_AUTOMATION: '"n8n consultant" OR "Make.com expert" OR "AI automation consultant"',
                COACHING: '"executive coach" OR "career coach" OR "leadership coach"',
                MARKETING_GROWTH: '"growth consultant" OR "fractional CMO"',
                BUSINESS_STRATEGY: '"strategy consultant" OR "fractional COO"',
              };
              const geography: Record<string, string> = {
                US: "United States", UK_IRELAND: "UK Ireland",
                OTHER_ENGLISH_SPEAKING: "Canada Australia Estonia",
              };
              const query = terms[discoveryCategory] + " " + geography[region] + " online consultation";
              return <a key={region} className="secondary" href={"https://www.google.com/search?q=" + encodeURIComponent(query)}
                target="_blank" rel="noopener noreferrer" style={{ textAlign: "center", padding: 12, borderRadius: 8 }}>
                Open web search: {regions.find(x => x[0] === region)?.[1]}
              </a>;
            })}
          </div>
        </div>

        {feeds.length ? <>
          <div className="form-grid">
            <label className="wide">Approved feed
              <select value={selectedFeed} onChange={e => { setSelectedFeed(e.target.value); setDiscovered([]); }}>
                {feeds.map(feed => <option key={feed} value={feed}>{feed}</option>)}
              </select>
            </label>
            <label>Category to review under
              <select value={discoveryCategory} onChange={e => setDiscoveryCategory(e.target.value)}>
                {categories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy || !selectedFeed} onClick={scanSource}>Scan feed (free)</button>
          </div>
          {discovered.length > 0 && <div className="table-scroll"><table>
            <thead><tr><th>Author</th><th>Article evidence</th><th>Decision</th></tr></thead>
            <tbody>{discovered.map(item => <tr key={item.discoveryKey}>
              <td>{item.name}</td>
              <td><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.headline}</a></td>
              <td><button disabled={busy} type="button" onClick={() => importLead(item)}>Import for review</button></td>
            </tr>)}</tbody>
          </table></div>}
          {!discovered.length && <p className="hint">Scan an approved source to see author candidates and evidence.</p>}
        </> : <p className="hint">No approved feeds configured yet. Set DISCOVERY_FEED_URLS to a comma-separated list of reviewed public RSS/Atom URLs in Render Environment, then redeploy.</p>}
        <p className="hint">Finding an article author does not confirm they offer English online consultations. Imported records stay REVIEW_PENDING, have no inferred email, and cannot generate an AI outreach draft until eligibility is verified.</p>
      </section>}
      {tab === "drafts" && <section className="panel"><h2>Saved AI drafts</h2><p className="muted">These are review-only drafts. The system cannot send email.</p>{drafts.map(d => <article className="draft" key={d.id}><div className="draft-top"><strong>{d.candidate.name}</strong><small>{d.provider} / {d.model}</small></div><h3>{d.subject}</h3><pre>{d.body}</pre><button className="secondary" onClick={() => navigator.clipboard.writeText(d.subject + "\n\n" + d.body)}>Copy draft</button></article>)}{!drafts.length && <p className="empty">No generated drafts yet.</p>}</section>}
      {tab === "settings" && <section className="panel setting-panel">
        <section aria-label="Research reconciliation diagnostics" className="review-panel">
          <h2>Research charge diagnostics</h2>
          <p className="muted">Read-only application ledger across all partner workspaces.
            No identifiers, API keys or external provider invoice data are shown.
            Paid AI web research remains disabled.</p>
          <button type="button" className="secondary"
            disabled={operatorResearchStatus === "loading"}
            onClick={() => void loadResearchReconciliation()}>
            {operatorResearchStatus === "loading" ? "Checking…" : "Check pending charges"}
          </button>
          {operatorResearchStatus === "error" && <p role="alert">
            Unable to load charge diagnostics. No financial records were changed.</p>}
          {operatorResearchStatus === "ready" && operatorResearch && <>
            <p role="status">{operatorResearch.needsReview ? "Manual review required" :
              "No aged reservations detected"} · {operatorResearch.staleReservations}
              {" "}aged claim(s), {operatorResearch.pendingReservations} total pending</p>
            <p>Estimated outstanding: {(operatorResearch.pendingCents / 100).toFixed(2)}
              {" "}USD · Aged: {(operatorResearch.staleCents / 100).toFixed(2)} USD</p>
            {operatorResearch.oldestStaleAt && <p>
              Oldest aged claim: {operatorResearch.oldestStaleAt}</p>}
            <p className="muted">Application estimates only · last checked:
              {" "}{operatorResearch.checkedAt}. No automatic refunds or provider calls.</p>
          </>}
        </section>
        <h2>Bring your own AI</h2>
        <p className="muted">Choose your provider, enter the model ID and optionally save your API key. Calls are made server-side; the key is encrypted at rest and never returned to the browser.</p>
        <form onSubmit={saveSettings}>
          <label>Provider<select value={setting.provider} onChange={e => setSetting({ ...setting, provider: e.target.value, model: defaultAiModels[e.target.value] ?? setting.model })}><option value="gemini">Google Gemini</option><option value="openai">OpenAI</option><option value="anthropic">Claude (Anthropic)</option></select></label>
          <label>Model ID<input required minLength={2} maxLength={80} value={setting.model} onChange={e => setSetting({ ...setting, model: e.target.value })} placeholder="gemini-2.5-flash"/></label>
          <label>API key<input type="password" autoComplete="new-password" placeholder={setting.keyConfigured ? "Key saved • leave blank to keep" : "Paste provider API key"} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>
          <div className="key-status">{setting.keyConfigured ? "● Key configured (fingerprint: " + setting.fingerprint + ")" : "○ No API key configured"}</div>
          <button disabled={busy}>Save AI configuration</button>
        </form>
        <p className="hint">Model usage may incur provider charges. Never paste a key into chat or GitHub. Changing providers requires a new key.</p>
        <section className="panel">
          <h2>Invite a partner</h2>
          <p className="muted">Provision a workspace for an invited Google identity. If email delivery is configured, an invitation is sent using the configured provider. No admin-scoped data is shared.</p>
          {!inviteEmailConfigured && <p role="status" className="hint">Invitation email is not configured. Access will be provisioned, but no email will be sent until RESEND_API_KEY and PARTNER_INVITE_FROM are set.</p>}
          {inviteReceipt && <p role="status" className="success">{inviteReceipt}</p>}
          <form onSubmit={invitePartner}>
            <label>Workspace
              <select value={partnerTarget} onChange={e => setPartnerTarget(e.target.value)}>
                <option value="new">Create a new workspace</option>
                {partnerWorkspaces.map(workspace => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
            {partnerTarget === "new" && <label>Workspace name<input required maxLength={120} value={partnerName}
              onChange={e => setPartnerName(e.target.value)} placeholder="Example: Gary / SnapyCall" /></label>}
            <label>Invited Google email<input required type="email" value={partnerEmail}
              onChange={e => setPartnerEmail(e.target.value)} placeholder="partner@example.com" /></label>
            <button type="submit" disabled={busy}>Provision partner access and invite</button>
          </form>
          <h3>Partner invitations</h3>
          <div className="table-scroll invitation-table"><table>
            <thead><tr><th>Workspace</th><th>Google account</th><th>Invitation</th><th>Action</th></tr></thead>
            <tbody>{partnerInvitations.map(invite => <tr key={invite.id}>
              <td data-label="Workspace">{invite.workspace}</td>
              <td data-label="Google account">{invite.email}</td>
              <td data-label="Invitation">{invite.status === "SENT" ? "Sent (provider accepted)" : invite.status}
                {invite.errorCode ? " · " + invite.errorCode : ""}</td>
              <td data-label="Action">{(["PENDING", "FAILED", "UNCONFIGURED", "MANUAL_REVIEW"].includes(invite.status) ||
                (invite.status === "SENDING" && invite.leaseUntil &&
                  Date.parse(invite.leaseUntil) <= Date.now())) ?
                <button type="button" className="secondary" disabled={busy || !inviteEmailConfigured}
                  onClick={() => resendPartnerInvite(invite.id, invite.status === "MANUAL_REVIEW")}>
                  {invite.status === "MANUAL_REVIEW" ? "Send new attempt" : "Retry invitation"}
                </button> : invite.status === "SENT" ?
                <button type="button" className="secondary" disabled={busy || !inviteEmailConfigured}
                  onClick={() => resendPartnerInvite(invite.id, true)}>Send again</button> :
                <span>—</span>}
                {invite.status !== "REVOKED" && <button type="button" className="danger"
                  disabled={busy} onClick={() => void revokePartnerMembership(invite)}>
                  Revoke access
                </button>}
              </td>
            </tr>)}</tbody>
          </table></div>
          {!partnerInvitations.length && <p className="muted">No invitations yet.</p>}
        </section>

        {setting.keyConfigured && <button className="danger" disabled={busy} onClick={() => execute(async () => { await api("/ai-settings", { method: "DELETE" }); await load(); setNotice("Saved AI credential deleted."); })}>Delete stored key</button>}
      </section>}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
