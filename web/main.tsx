import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Candidate = {
  id: string; name: string; email: string | null; category: string;
  region: string | null; onlineEnglish: boolean; status: string;
  sourceUrl: string; discoveryKey: string | null; expertProfileUrl: string | null;
  profileReviewed: boolean; suppressed: boolean; score: { score: number; eligible: boolean };
};
type Draft = { id: string; subject: string; body: string; provider: string; model: string; candidate: { name: string } };
type AiSetting = { provider: string; model: string; keyConfigured: boolean; fingerprint?: string };
type FeedEntry = { discoveryKey: string; name: string; headline: string; sourceUrl: string; feedUrl: string; proof: string };

const categories = [
  ["AI_AUTOMATION", "AI automation / no-code"],
  ["COACHING", "Coaching"],
  ["MARKETING_GROWTH", "Marketing & growth"],
  ["BUSINESS_STRATEGY", "Business strategy"],
];
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
  const [reviewProfileUrl, setReviewProfileUrl] = useState("");
  const [reviewRegion, setReviewRegion] = useState("");
  const [reviewEnglish, setReviewEnglish] = useState(false);
  const [candidate, setCandidate] = useState({
    name: "", email: "", category: "AI_AUTOMATION", region: "US", sourceUrl: "",
    onlineEnglish: false, legalBasis: "", contactReviewed: false,
  });

  async function load() {
    const [c, d, s] = await Promise.all([
      api<Candidate[]>("/candidates"),
      api<Draft[]>("/drafts"),
      api<AiSetting>("/ai-settings"),
    ]);
    setCandidates(c);
    setDrafts(d);
    setSetting(s);
    const sources = await api<{ feeds: string[] }>("/discovery/sources");
    setFeeds(sources.feeds);
    setSelectedFeed((previous) => sources.feeds.includes(previous) ? previous : (sources.feeds[0] ?? ""));
  }

  useEffect(() => {
    api<{ authenticated: boolean }>("/session")
      .then(async (session) => {
        if (session.authenticated) { setLoggedIn(true); await load(); }
      }).catch(() => setError("Unable to reach the admin API"));
  }, []);

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
      <div className="sidebar-bottom"><span className="state">● Draft-only mode</span><button className="ghost" onClick={logout}>Sign out</button></div>
    </aside>
    <section className="content">
      <header><div><span className="eyebrow">PILOT EXPERT ACQUISITION</span><h1>{tab === "candidates" ? "Expert candidates" : tab === "drafts" ? "Outreach drafts" : tab === "discovery" ? "Free lead discovery" : "Your AI provider"}</h1></div><span className="pill">No automatic sending</span></header>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="success" role="status">{notice}</div>}
      {tab === "candidates" && <>
        <div className="metrics">
          <div className="metric"><strong>{candidates.length}</strong><span>Total candidates</span></div>
          <div className="metric"><strong>{candidates.filter(c => c.score.eligible).length}</strong><span>Eligible for review</span></div>
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
        <section className="panel"><h2>Candidate pipeline</h2><div className="table-scroll"><table><thead><tr><th>Candidate</th><th>Category</th><th>Region</th><th>Score</th><th>Action</th></tr></thead><tbody>
          {candidates.map(c => <tr key={c.id}><td>
              <strong>{c.name}</strong><small>{c.email ?? "No email"}</small>
              <small><a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">{c.discoveryKey ? "Source article (unverified author)" : "Source profile"}</a></small>
              {c.discoveryKey && <small>{c.profileReviewed && c.expertProfileUrl
                ? <a href={c.expertProfileUrl} target="_blank" rel="noopener noreferrer">Reviewed expert profile</a>
                : "Expert profile not reviewed"}</small>}
            </td><td>{categories.find(x => x[0] === c.category)?.[1] ?? c.category}</td>
            <td>{c.region ?? "Unconfirmed"}</td>
            <td>{c.score.eligible ? c.score.score : "Not eligible"}</td>
            <td>
              {c.discoveryKey && <button type="button" className="secondary" disabled={busy} onClick={() => beginProfileReview(c)}>Review profile</button>}
              <button type="button" disabled={busy || !c.score.eligible || c.suppressed || !setting.keyConfigured} onClick={() => makeDraft(c.id)}>Generate draft</button>
            </td></tr>)}
          {!candidates.length && <tr><td colSpan={5} className="empty">No candidates yet. Add one above to start.</td></tr>}
        </tbody></table></div>
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
          <label>Provider<select value={setting.provider} onChange={e => setSetting({ ...setting, provider: e.target.value, model: e.target.value === "openai" ? "gpt-4.1-mini" : "gemini-2.5-flash" })}><option value="gemini">Google Gemini</option><option value="openai">OpenAI</option></select></label>
          <label>Model ID<input required minLength={2} maxLength={80} value={setting.model} onChange={e => setSetting({ ...setting, model: e.target.value })} placeholder="gemini-2.5-flash"/></label>
          <label>API key<input type="password" autoComplete="new-password" placeholder={setting.keyConfigured ? "Key saved • leave blank to keep" : "Paste provider API key"} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>
          <div className="key-status">{setting.keyConfigured ? "● Key configured (fingerprint: " + setting.fingerprint + ")" : "○ No API key configured"}</div>
          <button disabled={busy}>Save AI configuration</button>
        </form>
        <p className="hint">Model usage may incur provider charges. Never paste a key into chat or GitHub. Changing providers requires a new key.</p>
        {setting.keyConfigured && <button className="danger" disabled={busy} onClick={() => execute(async () => { await api("/ai-settings", { method: "DELETE" }); await load(); setNotice("Saved AI credential deleted."); })}>Delete stored key</button>}
      </section>}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
