// Only explicitly published, single-person schema.org JSON-LD is admissible.
// This extracts a source hint, not mailbox ownership, consent or a contact.
// No remote @context fetching, scripts, nested URL fetches or email guessing.
const EMAIL = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const PERSON_TYPE = /^(?:https?:\/\/schema\.org\/)?Person$/i;
const JSON_LD_TAG = /<script\b([^>]{0,1024})>([\s\S]*?)<\/script\s*>/gi;
const ATTRIBUTE = (attributes, key) => {
  const regex = new RegExp("(?:^|\\s)" + key +
    "\\s*=\\s*([\"'])([^\"']{1,128})\\1", "i");
  return regex.exec(attributes)?.[2] ?? null;
};

function normalizeName(value) {
  return typeof value === "string" && value.length >= 5 && value.length <= 160
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : null;
}
function normalizeEmail(value) {
  if (typeof value !== "string" || value.length > 254) return null;
  const email = /^mailto:/i.test(value) ? value.slice(7) : value;
  return EMAIL.test(email) ? email.toLowerCase() : null;
}
function schemaContext(value) {
  const context = value?.["@context"];
  if (typeof context === "string")
    return /^https?:\/\/schema\.org\/?$/i.test(context);
  if (Array.isArray(context))
    return context.some(item => typeof item === "string" &&
      /^https?:\/\/schema\.org\/?$/i.test(item));
  return false;
}
function personNodes(value) {
  // Parse root or a bounded graph only; never recursively traverse arbitrary
  // embedded objects or promote an Organization's email into Person evidence.
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!schemaContext(value)) return [];
  const graph = Array.isArray(value["@graph"]) ? value["@graph"] : [];
  // Never silently ignore later identities in an oversized graph.
  if (graph.length > 20) return null;
  return [value, ...graph].filter(node => node &&
    typeof node === "object" && !Array.isArray(node) &&
    (typeof node["@type"] === "string"
      ? PERSON_TYPE.test(node["@type"])
      : Array.isArray(node["@type"]) &&
        node["@type"].some(t => typeof t === "string" && PERSON_TYPE.test(t))));
}

export function explicitJsonLdPersonEmail(html) {
  if (typeof html !== "string" || Buffer.byteLength(html, "utf8") > 128 * 1024)
    return null;
  const people = [];
  for (const match of html.matchAll(JSON_LD_TAG)) {
    if (ATTRIBUTE(match[1], "type")?.toLowerCase() !== "application/ld+json")
      continue;
    if (match[2].length > 16_384) return null;
    let data;
    try { data = JSON.parse(match[2]); }
    catch { return null; }
    const roots = Array.isArray(data) ? data.slice(0, 20) : [data];
    if (Array.isArray(data) && data.length > 20) return null;
    for (const root of roots) {
      const nodes = personNodes(root);
      if (nodes === null) return null;
      people.push(...nodes);
    }
    if (people.length > 1) return null;
  }
  if (people.length !== 1) return null;
  const person = people[0];
  const name = normalizeName(person.name);
  const email = normalizeEmail(person.email);
  if (!name || !email || Array.isArray(person.name) ||
      Array.isArray(person.email)) return null;
  return { name, email };
}
