export type ReviewCandidate = { name: string; category: string; sourceUrl: string };
export type ReviewedSeed = ReviewCandidate & { key: string; manualSeed: true };
export function reviewedCandidateKey(candidate: ReviewCandidate): string;
export function resolvedReviewedSource(
  candidate: ReviewCandidate, urls: Record<string, string>,
): string | null;
export function reviewedSeedBatch(
  candidates: ReviewCandidate[],
  reviewedKeys: string[],
  reviewedUrls: Record<string, string>,
  savedKeys: string[],
): ReviewedSeed[];
