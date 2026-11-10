import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Candidate = {
  id: number; name: string; category: string; region: string;
  source: string; score: number;
};
type Draft = { id: number; name: string; subject: string; body: string };
const categories: Record<string, { label: string; weight: number }> = {
  AI_AUTOMATION: { label: "AI automation / no-code", weight: 30 },
  COACHING: { label: "Coaching", weight: 30 },
  MARKETING_GROWTH: { label: "Marketing & growth", weight: 20 },
  BUSINESS_STRATEGY: { label: "Business strategy", weight: 20 },
};
const regions: Record<string, { label: string; weight: number }> = {
  US: { label: "United States", weight: 40 },
  UK_IRELAND: { label: "UK / Ireland", weight: 40 },
  OTHER_ENGLISH_SPEAKING: { label: "Other English-speaking", weight: 20 },
};
const examples: Candidate[] = [
  { id: 1, name: "Example AI consultant", category: "AI_AUTOMATION", region: "US", source: "Fictional demo profile", score: 70 },
  { id: 2, name: "Example business coach", category: "COACHING", region: "UK_IRELAND", source: "Fictional demo profile", score: 70 },
  { id: 3, name: "Example growth strategist", category: "MARKETING_GROWTH", region: "OTHER_ENGLISH_SPEAKING", source: "Fictional demo profile", score: 40 },
];

function App() {
  const [tab, setTab] = useState<"candidates" | "drafts" | "settings">("candidates");
  const [candidates, setCandidates] = useState(examples);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [notice, setNotice] = useState("");
  const [provider, setProvider] = useState("gemini");
  const [model, setModel] = useState("gemini-2.5-flash");
  const [candidate, setCandidate] = useState({
    name: "", category: "AI_AUTOMATION", region: "US", source: "", englishOnline: true,
  });

  function addCandidate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidate.englishOnline) {
      setNotice("English-language online consultations must be confirmed.");
      return;
    }
    const score = categories[candidate.category].weight + regions[candidate.region].weight;
    setCandidates(items => [{
      id: Date.now(), name: candidate.name.trim(), category: candidate.category,
      region: candidate.region, source: candidate.source.trim(), score,
    }, ...items]);
    setCandidate(previous => ({ ...previous, name: "", source: "" }));
    setNotice("Added locally for this demo session. Refreshing resets all changes.");
  }

  function createDraft(item: Candidate) {
    const category = categories[item.category].label.toLowerCase();
    const subject = "Invitation to explore the SnapyCall pilot expert program";
    const body = [
      "Hello,",
      "",
      "We're reaching out to professionals working in " + category + " about SnapyCall's pilot expert program.",
      "SnapyCall is designed for paid live video consultations. If the pilot interests you, please review the application:",
      "https://forms.gle/5xGr5SbFAknhomTb6",
      "",
      "Best regards,",
      "SnapyCall Pilot Outreach",
      "",
      "[DEMO TEMPLATE — not AI-generated and not sent]",
    ].join("\n");
    setDrafts(items => [{ id: Date.now(), name: item.name, subject, body }, ...items]);
    setTab("drafts");
    setNotice("Example draft created in memory only. No AI call or email send.");
  }

  return <div className="layout">
    <aside>
      <div className="brand">SNAPYCALL <span>/ PILOT</span></div>
      <p className="sidebar-label">PHONE PREVIEW</p>
      <nav aria-label="Preview sections">
        <button type="button" className={tab === "candidates" ? "active" : ""} onClick={() => setTab("candidates")}>Candidates</button>
        <button type="button" className={tab === "drafts" ? "active" : ""} onClick={() => setTab("drafts")}>Outreach drafts</button>
        <button type="button" className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>AI configuration</button>
      </nav>
      <div className="sidebar-bottom"><span className="state">● Public static preview</span></div>
    </aside>
    <main className="content">
      <header>
        <div><span className="eyebrow">GITHUB PAGES · UI DEMO</span>
          <h1>{tab === "candidates" ? "Pilot candidates" : tab === "drafts" ? "Draft review" : "Bring your own AI"}</h1>
        </div>
        <span className="pill">Preview only</span>
      </header>
      <div className="success" role="status">
        <strong>Static demonstration.</strong> Fictional contacts only. No login, database, API keys, AI calls, or email delivery. Changes are cleared on refresh.
      </div>
      {notice && <div role="status" className="success">{notice}</div>}
      {tab === "candidates" && <>
        <div className="metrics">
          <div className="metric"><strong>{candidates.length}</strong><span>Demo candidates</span></div>
          <div className="metric"><strong>{candidates.filter(c => c.score >= 60).length}</strong><span>Priority matches</span></div>
          <div className="metric"><strong>{drafts.length}</strong><span>Local drafts</span></div>
        </div>
        <section className="panel">
          <h2>Add a fictional candidate</h2>
          <form className="form-grid" onSubmit={addCandidate}>
            <label>Name<input required maxLength={160} value={candidate.name} onChange={e => setCandidate({ ...candidate, name: e.target.value })}/></label>
            <label>Category<select value={candidate.category} onChange={e => setCandidate({ ...candidate, category: e.target.value })}>
              {Object.entries(categories).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
            </select></label>
            <label>Region<select value={candidate.region} onChange={e => setCandidate({ ...candidate, region: e.target.value })}>
              {Object.entries(regions).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
            </select></label>
            <label>Source description<input required maxLength={160} placeholder="Fictional demonstration source" value={candidate.source} onChange={e => setCandidate({ ...candidate, source: e.target.value })}/></label>
            <label><input type="checkbox" checked={candidate.englishOnline} onChange={e => setCandidate({ ...candidate, englishOnline: e.target.checked })}/> English online consultations confirmed</label>
            <button type="submit">Add demo candidate</button>
          </form>
        </section>
        <section className="panel">
          <h2>Candidate pipeline</h2>
          <div className="table-scroll"><table><thead><tr><th>Candidate</th><th>Category</th><th>Region</th><th>Score</th><th>Preview</th></tr></thead><tbody>
            {candidates.map(item => <tr key={item.id}>
              <td><strong>{item.name}</strong><small>{item.source}</small></td>
              <td>{categories[item.category].label}</td><td>{regions[item.region].label}</td>
              <td>{item.score}</td><td><button type="button" onClick={() => createDraft(item)}>Create draft</button></td>
            </tr>)}
          </tbody></table></div>
        </section>
      </>}
      {tab === "drafts" && <section className="panel">
        <h2>Example outreach drafts</h2>
        <p className="muted">Generated from a fixed example template, not from any AI model. No email sending is available.</p>
        {drafts.map(item => <article className="draft" key={item.id}>
          <strong>{item.name}</strong><h3>{item.subject}</h3><pre>{item.body}</pre>
          <button className="secondary" type="button" onClick={() => navigator.clipboard?.writeText(item.subject + "\n\n" + item.body)}>Copy sample</button>
        </article>)}
        {!drafts.length && <p className="empty">Select a candidate and create a sample draft.</p>}
      </section>}
      {tab === "settings" && <section className="panel setting-panel">
        <h2>AI settings — UI preview</h2>
        <p className="muted">This form demonstrates the production AI configuration UI. It cannot save credentials or contact a model. Do not enter real API keys into a public demo.</p>
        <label>Provider<select value={provider} onChange={e => {
          setProvider(e.target.value);
          setModel(e.target.value === "openai" ? "gpt-4.1-mini" : "gemini-2.5-flash");
        }}><option value="gemini">Google Gemini</option><option value="openai">OpenAI</option></select></label>
        <label>Model ID<input value={model} maxLength={80} onChange={e => setModel(e.target.value)}/></label>
        <p className="key-status">● API key entry disabled in the public demo</p>
        <button type="button" disabled>Save configuration (requires authenticated backend)</button>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
