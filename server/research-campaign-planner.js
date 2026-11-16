// Deterministic planning only: never calls a provider, crawls a URL or sends mail.
import { createHash } from "node:crypto";
import { z } from "zod";

export const campaignInput = z.object({
  query: z.string().trim().min(12).max(240),
  targetCount: z.number().int().min(20).max(200).default(100),
  idempotencyKey: z.string().uuid(),
}).strict();

const regions = Object.freeze([
  "United States and Canada",
  "United Kingdom and Ireland",
  "Northern and Western Europe",
  "Southern and Eastern Europe",
  "Australia and New Zealand",
  "Asia and international remote professionals",
]);
const facets = Object.freeze([
  "independent consultants and freelance practitioners",
  "specialist advisors and professional educators",
  "agency founders and professional service experts",
  "speakers, authors and community experts",
]);

// 24 independent bounded tasks allow retry and saturation without a single
// huge model response. A 100-result goal is NOT a guarantee of 100 contacts.
export function planResearchCampaign(value) {
  const input = campaignInput.parse(value);
  const tasks = [];
  for (const region of regions) {
    for (const facet of facets) {
      const query = [
        input.query,
        "Find verified public professional profiles in",
        region + "; focus on", facet,
        "and exclude unsupported claims.",
      ].join(" ");
      if (query.length > 350) {
        throw new TypeError("Campaign criteria too long to partition safely");
      }
      const index = tasks.length;
      tasks.push(Object.freeze({
        index,
        limit: 10,
        query,
        region,
        facet,
        // A stable task key supports idempotent resumption after a crash.
        key: createHash("sha256").update(JSON.stringify([index, query]))
          .digest("hex"),
      }));
    }
  }
  return Object.freeze({
    query: input.query,
    targetCount: input.targetCount,
    idempotencyKey: input.idempotencyKey,
    planVersion: "ai62-planner-v1",
    tasks: Object.freeze(tasks),
    maxTasks: tasks.length,
    maxCandidateObservations: tasks.reduce((n, t) => n + t.limit, 0),
    // The executor must independently enforce spend/quota on every search.
    providerCallsAuthorized: false,
    sendEnabled: false,
  });
}
