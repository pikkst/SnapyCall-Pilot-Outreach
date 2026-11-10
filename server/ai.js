import { z } from "zod";

export const aiConfigSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(2).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/),
  apiKey: z.string().min(8).max(4096).optional(),
});

async function safePost(url, headers, payload, signal) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), signal });
  if (!response.ok) throw new Error("AI provider request failed (HTTP " + response.status + ")");
  const json = await response.json();
  return json;
}

export async function generateDraft({ provider, model, apiKey, candidate }, options = {}) {
  const parsed = aiConfigSchema.parse({ provider, model, apiKey });
  if (!apiKey) throw new Error("AI provider key not configured");
  const prompt = [
    "Write a short, factual, personalized invitation to apply as a pilot expert for SnapyCall.",
    "SnapyCall offers paid live video consultations. Do not invent credentials, prior relationships, or benefits.",
    "Do not impersonate Gary or claim a guaranteed outcome. Do not include private data.",
    "Application link: https://forms.gle/5xGr5SbFAknhomTb6",
    "Candidate name: " + candidate.name,
    "Category: " + candidate.category,
    "Evidence URL: " + candidate.sourceUrl,
    "Return only plain text with first line as email subject, followed by a blank line and body.",
  ].join("\n");
  const fetcher = options.post ?? safePost;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    let result;
    if (parsed.provider === "openai") {
      // The host is a constant allowlisted provider endpoint, never user-supplied.
      result = await fetcher("https://api.openai.com/v1/chat/completions",
        { authorization: "Bearer " + apiKey },
        { model: parsed.model, messages: [{ role: "user", content: prompt }], max_tokens: 500 },
        controller.signal);
      const content = result?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("AI provider returned no text");
      return parseDraft(content);
    }
    result = await fetcher("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(parsed.model) + ":generateContent",
      { "x-goog-api-key": apiKey },
      { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 650 } },
      controller.signal);
    const content = result?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    if (typeof content !== "string" || !content) throw new Error("AI provider returned no text");
    return parseDraft(content);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseDraft(text) {
  const input = text.trim().slice(0, 6500);
  const [first, ...rest] = input.split(/\r?\n/);
  const subject = first.replace(/^subject:\s*/i, "").trim().slice(0, 180);
  const body = rest.join("\n").trim();
  if (!subject || !body) throw new Error("AI provider returned an invalid draft");
  return { subject, body: body.slice(0, 6000) };
}
