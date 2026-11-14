import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { manualIndependentResearch } from "../src/manual-research.js";

type PartnerSession = { authenticated: boolean; displayName?: string | null; partners?: Array<{ id: string; name: string; role: string }> };
type GoogleConnection = { partnerId: string; scope: string; updatedAt: string };
type PartnerInvitation = { id: string; workspaceId: string; workspace: string;
  email: string; status: string; sentAt: string | null; acceptedAt: string | null;
  leaseUntil: string | null; errorCode: string | null; attempt: number };
type ConnectionStatus = "loading" | "ready" | "unavailable";
type ConnectionResponse = { connections: GoogleConnection[]; available: boolean };
type GmailStatus = { connected: boolean; available: boolean; email: string; sendingEnabled: false };
type Candidate = {
  id: string; name: string; email: string | null; category: string;
  region: string | null; onlineEnglish: boolean; status: string;
  sourceUrl: string; discoveryKey: string | null; expertProfileUrl: string | null;
  profileReviewed: boolean; suppressed: boolean;
  score: { score: number | null; eligible: boolean; stage: string };
  qualification: { stage: string; qualified: boolean; score: null; blockers: string[] };
  outreach: { stage: string; canDraft: boolean; canSend: false; blockers: string[] };
};
type Draft = { id: string; subject: string; body: string; provider: string; model: string; candidate: { name: string } };
type ResearchPreview = {
  workspaceId: string; candidates: Array<{
    name: string; category: string; sourceUrl: string; rationale: string;
    email: null; contactReviewed: false; status: "REVIEW_PENDING";
  }>;
  sources: Array<{ url: string; title: string }>;
  warnings: string[]; usage: { inputTokens: number | null;
    outputTokens: number | null; searchRequests: number | null };
  imported: false; reviewRequired: true; sendingEnabled: false;
};
type AiSetting = { provider: string; model: string; keyConfigured: boolean; fingerprint?: string };
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
  const [partnerTab, setPartnerTab] = useState<"candidates" | "discovery" | "drafts" | "settings">("candidates");
  const [partnerSession, setPartnerSession] = useState<PartnerSession | null>(null);
  const [googleConnections, setGoogleConnections] = useState<GoogleConnection[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("loading");
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [gmailStatusError, setGmailStatusError] = useState(false);
  const [personalAi, setPersonalAi] = useState<AiSetting>({
    provider: "gemini", model: "gemini-2.5-flash", keyConfigured: false,
  });
  const [personalApiKey, setPersonalApiKey] = useState("");
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
    Promise.all([api<{ authenticated: boolean }>("/session"),
      api<PartnerSession>("/partner/session")])
      .then(async ([session, partner]) => {
        if (session.authenticated) { setLoggedIn(true); await load(); }
        else if (partner.authenticated) {
          setPartnerSession(partner);
          await loadGoogleConnections();
          await loadGmailStatus();
          await loadPersonalAiSettings();
        }
      }).catch(() => setError("Unable to reach the authentication API"));
  }, []);

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
      const research = manualIndependentResearch(item.name, item.category, item.sourceUrl);
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
    try {
      const result = await api<ResearchPreview>("/discovery/ai-research?workspaceId=" +
        encodeURIComponent(workspaceId), {
        method: "POST", body: JSON.stringify({ query: researchQuery.trim(), limit: 10 }),
      });
      if (workspaceRequest.current !== generation || result.workspaceId !== workspaceId) return;
      setResearchResult(result);
      setResearchStatus("idle");
    } catch (error) {
      if (workspaceRequest.current !== generation) return;
      setResearchStatus("error");
      setResearchError(error instanceof Error ? error.message : "Research unavailable");
    }
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

  if (partnerSession?.authenticated && !loggedIn) return (
    <main className="layout">
      <aside>
        <div className="brand">SNAPYCALL<span> / PILOT</span></div>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="Workspace sections">
          {(["candidates", "discovery", "drafts", "settings"] as const).map(item =>
            <button type="button" key={item} className={partnerTab === item ? "active" : ""}
              onClick={() => setPartnerTab(item)}>
              {item === "settings" ? "AI configuration" : item === "drafts" ? "Outreach drafts" :
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
            "Free lead discovery" : partnerTab === "drafts" ? "Outreach drafts" : "Your AI provider"}</h1>
          <p className="muted">Welcome{partnerSession.displayName ? ", " + partnerSession.displayName : ""}.
            Your access is limited to your authorized workspaces.</p>
        </div><span className="pill">No automatic sending</span></header>
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="success" role="status">{notice}</div>}
        {partnerTab !== "settings" && <section className="panel">
          <p className="muted">Candidate and draft data are workspace-scoped. Manual lead
            entry is review-only; automated importing, AI drafting and sending remain disabled
            until their separate authorization gates are released.</p>
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
                  <p className="muted">Optional paid Claude search (up to 3 web searches). Results are unverified,
                    not saved or authorized for outreach. No emails will be sent.</p>
                  <form onSubmit={event => void runResearch(p.id, event)}>
                    <label>Research criteria
                      <input value={researchQuery} maxLength={350} minLength={12} required
                        onChange={event => setResearchQuery(event.target.value)}/>
                    </label>
                    <button type="submit" disabled={researchStatus === "loading" ||
                      personalAi.provider !== "anthropic" || !personalAi.keyConfigured}>
                      {researchStatus === "loading" ? "Researching…" : "Search public web"}
                    </button>
                  </form>
                  {(personalAi.provider !== "anthropic" || !personalAi.keyConfigured) &&
                    <p className="muted">Configure your personal Claude API key under My AI provider first.</p>}
                  {researchStatus === "error" && <p role="alert">{researchError}</p>}
                  {researchResult && <>
                    <p className="muted">{researchResult.candidates.length} candidates for manual review.
                      Web requests: {researchResult.usage.searchRequests ?? "unknown"}.
                      No candidates were imported.</p>
                    {researchResult.warnings.map(message => <p key={message} className="muted">{message}</p>)}
                    <ul>{researchResult.candidates.map(item =>
                      <li key={item.sourceUrl + item.name}>
                        <strong>{item.name}</strong> — {item.category}
                        <p>{item.rationale}</p>
                        <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                          Provider-cited source</a>
                      </li>)}</ul>
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
              <small><a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">{c.discoveryKey ? "Source article (unverified author)" : "Source profile"}</a></small>
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
