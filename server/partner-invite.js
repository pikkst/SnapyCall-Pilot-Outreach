import { randomUUID } from "node:crypto";

export function invitationMailerConfig(env = process.env) {
  const { RESEND_API_KEY: apiKey, PARTNER_INVITE_FROM: from,
    PARTNER_INVITE_APP_URL: appUrl } = env;
  if (!apiKey || !from || !appUrl) return null;
  const url = new URL(appUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash || url.pathname !== "/" || !url.hostname) {
    throw new Error("PARTNER_INVITE_APP_URL must be an HTTPS origin");
  }
  if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(from)) {
    throw new Error("Invalid PARTNER_INVITE_FROM address");
  }
  return { apiKey, from, appUrl: url.origin };
}

export function renderPartnerInvitation({ workspaceName, signInUrl }) {
  const safeName = String(workspaceName).slice(0, 120);
  const escaped = safeName.replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const text = `You have been invited to ${safeName} on SnapyCall Pilot Outreach.\n\nSign in with your invited Google account: ${signInUrl}\n\nThis invitation does not grant access to other workspaces. If you were not expecting it, you can ignore this message.`;
  const html = `<p>You have been invited to <strong>${escaped}</strong> on SnapyCall Pilot Outreach.</p><p><a href="${signInUrl}">Sign in with Google</a></p><p>Only the invited Google account can access this workspace. If unexpected, ignore this email.</p>`;
  return { subject: "SnapyCall Pilot Outreach invitation", text, html };
}

export async function deliverPartnerInvitation(db, deliveryId, config, fetcher = fetch) {
  if (!config) return { emailStatus: "NOT_CONFIGURED" };
  const claimed = await db.partnerInviteDelivery.updateMany({
    where: { id: deliveryId, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "SENDING", claimedAt: new Date(), attempts: { increment: 1 }, errorCode: null },
  });
  if (claimed.count !== 1) {
    const row = await db.partnerInviteDelivery.findUnique({ where: { id: deliveryId } });
    return { emailStatus: row?.status ?? "NOT_FOUND" };
  }
  const row = await db.partnerInviteDelivery.findUnique({
    where: { id: deliveryId }, include: { membership: { include: { partner: true } } },
  });
  if (!row || row.membership.revokedAt) {
    await db.partnerInviteDelivery.update({ where: { id: deliveryId },
      data: { status: "FAILED", errorCode: "REVOKED" } });
    return { emailStatus: "FAILED" };
  }
  const url = config.appUrl;
  const message = renderPartnerInvitation({ workspaceName: row.membership.partner.name, signInUrl: url });
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: "Bearer " + config.apiKey,
        "content-type": "application/json",
        "Idempotency-Key": row.deliveryKey,
      },
      body: JSON.stringify({ from: config.from, to: [row.emailNormalized],
        subject: message.subject, html: message.html, text: message.text }),
    });
    if (!response.ok) throw new Error("PROVIDER_REJECTED");
    const body = await response.json();
    if (typeof body?.id !== "string" || !body.id) throw new Error("INVALID_PROVIDER_RESPONSE");
    await db.partnerInviteDelivery.update({ where: { id: deliveryId },
      data: { status: "SENT", providerMessageId: body.id, sentAt: new Date(), errorCode: null } });
    return { emailStatus: "SENT" };
  } catch (error) {
    const code = error instanceof Error && error.message === "PROVIDER_REJECTED"
      ? "PROVIDER_REJECTED" : "DELIVERY_UNCONFIRMED";
    await db.partnerInviteDelivery.update({ where: { id: deliveryId },
      data: { status: "FAILED", errorCode: code } });
    return { emailStatus: "FAILED" };
  }
}

export function newInviteDeliveryKey() {
  return randomUUID();
}
