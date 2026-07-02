/**
 * Gravatar 大頭貼 URL(與舊版行為一致)。
 */
import crypto from "node:crypto";

export function gravatarUrl(email: string, size = 64): string {
  const h = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
  return `https://www.gravatar.com/avatar/${h}?s=${size}&d=identicon`;
}

/**
 * 取得使用者的 gravatar URL:優先用 email,否則若 username 看起來像 email 就用它。
 * 都沒有則回 null。
 */
export function effectiveGravatar(
  user: { email?: string | null; username?: string | null },
  size = 64,
): string | null {
  let email = (user.email ?? "").trim();
  if (!email) {
    const username = user.username ?? "";
    if (username.includes("@")) email = username;
  }
  return email ? gravatarUrl(email, size) : null;
}
