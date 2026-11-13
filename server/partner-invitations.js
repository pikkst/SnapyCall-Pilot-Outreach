// Partner-access invitations only. Deliberately separate from outreach drafts.
const PROVIDER_URL = "https://api.resend.com/emails";
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function invitationEmailConfig(env = process.env) {
  const { RESEND_API_KEY: apiKey, PARTNER_INVITE_FROM: from, GOOGLE_REDIRECT_URI: redirectUri } = env;
  if (!apiKey || !from || !redirectUri) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.trim().replace(/^.*<([^>]+)>$/, "$1"))) {
    throw new Error("Invalid PARTNER_INVITE_FROM");
  }
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" || redirect.username || redirect.password ||
      redirect.search || redirect.hash || redirect.pathname !== "/api/auth/google/callback") {
    throw new Error("Invalid partner invitation login origin");
  }
  return { apiKey, from, loginUrl: new URL("/", redirect.origin).toString() };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function createInvitationEmail({ from, loginUrl }, { email, workspace }) {
  const text = [
    "You have been invited to SnapyCall Pilot Outreach.",
    "",
    "Workspace: " + workspace,
    "Invited Google account: " + email,
    "",
    "Sign in using the invited Google account:",
    loginUrl,
    "",
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n");
  const html = `<p>You have been invited to <strong>SnapyCall Pilot Outreach</strong>.</p>
<p>Workspace: <strong>${escapeHtml(workspace)}</strong></p>
<p>Invited Google account: ${escapeHtml(email)}</p>
<p><a href="${escapeHtml(loginUrl)}">Sign in with Google</a> using the invited account.</p>
<p>If you were not expecting this invitation, you can ignore this email.</p>`;
  return { from, to: [email], subject: "Invitation to SnapyCall Pilot Outreach", html, text };
}

export async function sendInvitationEmail(config, membership, fetcher = fetch) {
  const payload = createInvitationEmail(config, {
    email: membership.user.emailNormalized, workspace: membership.partner.name,
  });
  const response = await fetcher(PROVIDER_URL, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: {
      authorization: "Bearer " + config.apiKey,
      "content-type": "application/json",
      "Idempotency-Key": "snapycall-invite-" + membership.id + "-" + membership.inviteAttempt,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("EMAIL_PROVIDER_REJECTED");
  const result = await response.json();
  if (typeof result?.id !== "string" || !result.id) throw new Error("EMAIL_PROVIDER_INVALID_RESPONSE");
  return result.id;
}

export function publicInvitationStatus(member) {
  if (member.revokedAt) return "REVOKED";
  if (member.acceptedAt) return "ACCEPTED";
  return member.inviteStatus;
}

// A successful provider response indicates acceptance by Resend, not inbox delivery.
// The lease fences concurrent requests. The same key is used for safe retries
// within the provider's 24-hour idempotency window.
export async function deliverPartnerInvitation(prisma, membershipId, env = process.env,
  fetcher = fetch, now = new Date()) {
  const member = await prisma.partnerMembership.findUnique({
    where: { id: membershipId }, include: { partner: true, user: true },
  });
  if (!member) return { status: "NOT_FOUND" };
  if (member.revokedAt || member.acceptedAt) return { status: publicInvitationStatus(member) };
  const config = invitationEmailConfig(env);
  if (!config) {
    await prisma.partnerMembership.updateMany({
      where: { id: member.id, inviteStatus: { in: ["PENDING", "FAILED", "UNCONFIGURED"] } },
      data: { inviteStatus: "UNCONFIGURED", inviteErrorCode: "EMAIL_NOT_CONFIGURED" },
    });
    return { status: "UNCONFIGURED" };
  }
  if (member.inviteStatus === "SENT") return { status: "SENT" };
  const staleLease = member.inviteStatus === "SENDING" &&
    member.inviteLeaseUntil && member.inviteLeaseUntil.getTime() <= now.getTime();
  if (member.inviteStatus === "SENDING" && !staleLease) return { status: "SENDING" };
  if (member.inviteStatus === "MANUAL_REVIEW") return { status: "MANUAL_REVIEW" };
  if (member.inviteAttemptAt && now.getTime() - member.inviteAttemptAt.getTime() >= RETRY_WINDOW_MS) {
    await prisma.partnerMembership.updateMany({
      where: { id: member.id, inviteAttempt: member.inviteAttempt,
        inviteStatus: member.inviteStatus },
      data: { inviteStatus: "MANUAL_REVIEW", inviteErrorCode: "RETRY_WINDOW_EXPIRED" },
    });
    return { status: "MANUAL_REVIEW" };
  }
  const leaseUntil = new Date(now.getTime() + 120000);
  const claimed = await prisma.partnerMembership.updateMany({
    where: { id: member.id, inviteAttempt: member.inviteAttempt,
      acceptedAt: null, revokedAt: null,
      OR: [
        { inviteStatus: { in: ["PENDING", "FAILED", "UNCONFIGURED"] } },
        { inviteStatus: "SENDING", inviteLeaseUntil: { lte: now } },
      ] },
    data: { inviteStatus: "SENDING", inviteLeaseUntil: leaseUntil,
      inviteAttemptAt: member.inviteAttemptAt ?? now, inviteErrorCode: null },
  });
  if (claimed.count !== 1) return { status: "SENDING" };
  let outcome, providerId;
  try {
    providerId = await sendInvitationEmail(config, member, fetcher);
    outcome = "SENT";
  } catch {
    outcome = "FAILED";
  }
  const done = await prisma.partnerMembership.updateMany({
    where: { id: member.id, inviteStatus: "SENDING", inviteLeaseUntil: leaseUntil },
    data: { inviteStatus: outcome, inviteLeaseUntil: null,
      inviteProviderId: providerId ?? null,
      inviteSentAt: outcome === "SENT" ? new Date() : null,
      inviteErrorCode: outcome === "FAILED" ? "EMAIL_SEND_FAILED" : null },
  });
  return { status: done.count ? outcome : "UNKNOWN" };
}
