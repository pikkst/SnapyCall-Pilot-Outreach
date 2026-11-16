export function singleAuthorizedWorkspaceId(session: {
  authenticated?: boolean;
  userId?: string | null;
  partners?: Array<{ id: string }>;
} | null | undefined): string | null;
