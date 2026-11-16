import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { manualIndependentResearch } from "../src/manual-research.js";
import { reviewedCandidateKey, resolvedReviewedSource, reviewedSeedBatch, selectedDiscoverySeedBatch } from "../src/research-review-batch.js";

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
  contact_review_pending: "Review contact details", suppressed: "Contact is suppressed",
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
  const [partnerTab, setPartnerTab] = useState<"candidates" | "discovery" | "drafts" | "profile" | "settings">("candidates");
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
  const partnerEvidenceRequest = useRef(0);
  const partnerReviewRequest = useRef(0);
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
    ++partnerEvidenceRequest.current;
    ++partnerReviewRequest.current;
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
    } catch {
      if (workspaceRequest.current !== generation) return;
      setWorkspaceCandidates([]);
      setWorkspaceDrafts([]);
      setWorkspaceDataStatus("error");
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
      setNotice("Your AI key was saved to your account (encrypted). No AI request was made.");
    });
  }

  async function deletePersonalAiSettings() {
    await execute(async () => {
      await api("/ai-settings", { method: "DELETE" });
      setPersonalApiKey("");
      await loadPersonalAiSettings();
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
          {(["candidates", "discovery", "drafts", "profile", "settings"] as const).map(item =>
            <button type="button" key={item} className={partnerTab === item ? "active" : ""}
              onClick={() => setPartnerTab(item)}>
              {item === "profile" ? "My profile" : item === "settings" ? "AI configuration" : item === "drafts" ? "Outreach drafts" :
                item === "discovery" ? "Free discovery" : "Candidates"}
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
          <h1>{partnerTab === "candidates" ? "Expert candidates" : partnerTab === "discovery" ?
            "Free lead discovery" : partnerTab === "drafts" ? "Outreach drafts" :
            partnerTab === "profile" ? "My profile" : "Your AI provider"}</h1>
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
        <h2>My workspaces</h2>
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
              View my workspace
            </button>
            {activeWorkspaceId === p.id &&
              <section aria-label={"Workspace " + p.name}>
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
                  <form onSubmit={event => void runResearch(p.id, event)}>
                    <label>Research criteria
                      <input value={researchQuery} maxLength={350} minLength={12} required
                        onChange={event => setResearchQuery(event.target.value)}/>
                    </label>
                    <button type="submit" disabled={researchStatus === "loading" ||
                      !personalAi.keyConfigured || personalAiStatus !== "ready" ||
                      researchLimitsStatus !== "ready"}>
                      {researchStatus === "loading" ? "Researching…" : "Search public web"}
                    </button>
                  </form>
                  {!personalAi.keyConfigured &&
                    <p className="muted">Configure a personal Gemini, OpenAI or Claude API key
                      under My AI provider first.</p>}
                  {researchBudget.monthlyLimitCents === null &&
                    <p className="muted">Set your monthly USD budget in My AI provider
                      before web research; otherwise provider calls are blocked.</p>}
                  {researchLimitsStatus !== "ready" && <p className="muted">
                    Personal research limits are unavailable; search is disabled until loaded.</p>}
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
                {partnerTab !== "discovery" && <>
                <h3>My candidates and outreach drafts</h3>
                <p className="muted">Workspace-isolated read-only preview. Editing,
                  discovery import, AI drafting and sending are not enabled for Google users yet.</p>
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
                  </div>
                  {partnerTab === "candidates" && <>
                    <h3>Candidate pipeline</h3>
                    <div className="table-scroll"><table><thead><tr>
                      <th>Candidate</th><th>Category</th><th>Region</th><th>Next action</th><th>Review</th>
                    </tr></thead><tbody>
                      {workspaceCandidates.map(c => <tr key={c.id}>
                        <td><strong>{c.name}</strong><small>{c.email ?? "No email"}</small></td>
                        <td>{categories.find(x => x[0] === c.category)?.[1] ?? c.category}</td>
                        <td>{c.region ?? "Unconfirmed"}</td>
                        <td>{stageNames[c.qualification.stage] ?? c.qualification.stage}</td>
                        <td>
                          <button type="button" className="secondary" disabled={busy}
                            onClick={() => void openPartnerEvidence(p.id, c.id)}>Evidence</button>
                          <button type="button" className="secondary" disabled={busy}
                            onClick={() => openIndependentManualSearch(c)}>Search independently</button>
                          <button type="button" className="secondary" disabled={busy}
                            onClick={() => prepareIndependentResearch(c)}>Prepare AI criteria</button>
                          {c.discoveryKey && <button type="button" className="secondary"
                            disabled={busy || partnerReviewSaving} onClick={() => beginProfileReview(c)}>
                            Review profile
                          </button>}
                        </td>
                      </tr>)}
                      {!workspaceCandidates.length && <tr><td colSpan={5} className="empty">No candidates in this workspace.</td></tr>}
                    </tbody></table></div>
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
                <p className="muted">Google Forms & Sheets: authorized (read-only). Sync is not yet enabled.</p>
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
