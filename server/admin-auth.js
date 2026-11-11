import bcrypt from "bcryptjs";

const ADMIN_ID = "admin";

export function validateBootstrapPassword(password) {
  if (typeof password !== "string" || password.length < 12 ||
      Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("ADMIN_PASSWORD must contain at least 12 characters and no more than 72 UTF-8 bytes");
  }
  return password;
}

// Database is the authority. The environment password is a one-time bootstrap
// secret only, and must never reset a previously initialized admin account.
export async function bootstrapAdmin(prisma, env) {
  const existing = await prisma.adminCredential.findUnique({ where: { id: ADMIN_ID } });
  if (existing) return { created: false };
  if (!env.ADMIN_PASSWORD) {
    throw new Error("Admin credential missing; supply ADMIN_PASSWORD for one-time bootstrap");
  }
  const password = validateBootstrapPassword(env.ADMIN_PASSWORD);
  const passwordHash = await bcrypt.hash(password, 12);
  const email = env.ADMIN_EMAIL.trim().toLowerCase();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.adminCredential.create({ data: { id: ADMIN_ID, email, passwordHash } });
      await tx.auditEvent.create({
        data: { actorId: ADMIN_ID, action: "admin.bootstrap.completed", entityId: ADMIN_ID },
      });
    });
    return { created: true };
  } catch (error) {
    // If two instances race, the unique PK ensures only one credential wins.
    // Do not overwrite it with the losing instance's bootstrap password.
    if (error?.code !== "P2002") throw error;
    const winner = await prisma.adminCredential.findUnique({ where: { id: ADMIN_ID } });
    if (!winner) throw error;
    return { created: false };
  }
}

export async function verifyAdmin(email, password, prisma) {
  const credential = await prisma.adminCredential.findUnique({ where: { id: ADMIN_ID } });
  if (!credential) return false;
  const validPassword = await bcrypt.compare(password, credential.passwordHash);
  return validPassword && typeof email === "string" &&
    email.trim().toLowerCase() === credential.email;
}
