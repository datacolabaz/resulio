/**
 * One input field accepts either a bare invite code or a full invite link (with or without
 * protocol/domain, group code or email-restricted token). Matching `/join/<x>` or `/invite/<x>`
 * anywhere in the pasted text — rather than parsing it as a URL — handles a link pasted with no
 * "https://", a bare domain, or trailing query params, without choking on any of them.
 */
const JOIN_CODE_IN_LINK = /\/join\/([^/?#\s]+)/i;
const INVITE_TOKEN_IN_LINK = /\/invite\/([^/?#\s]+)/i;
/** Case-sensitive: single-use link tokens are base64url. */
const SINGLE_USE_TOKEN_IN_LINK = /\/g\/([A-Za-z0-9_-]{43})(?=[/?#\s]|$)/;

/** Route to navigate to for a pasted code or link, or null when there's nothing usable yet. */
export function resolveJoinInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const joinMatch = trimmed.match(JOIN_CODE_IN_LINK);
  if (joinMatch) return `/join/${encodeURIComponent(decodeURIComponent(joinMatch[1]))}`;

  const inviteMatch = trimmed.match(INVITE_TOKEN_IN_LINK);
  if (inviteMatch) return `/invite/${encodeURIComponent(decodeURIComponent(inviteMatch[1]))}`;

  const singleUseMatch = trimmed.match(SINGLE_USE_TOKEN_IN_LINK);
  if (singleUseMatch) return `/g/${singleUseMatch[1]}`;

  const code = trimmed.toUpperCase().replace(/\s+/g, "");
  return code.length >= 4 ? `/join/${encodeURIComponent(code)}` : null;
}

/**
 * Keeps a bare code upper-cased and space-free as the user types (matches the server's own
 * normalization). Left untouched once the text looks like a link/path (contains "/" or "."), so
 * a pasted URL or a case-sensitive token isn't mangled.
 */
export function normalizeJoinInput(raw: string): string {
  return /[/.]/.test(raw) ? raw : raw.toUpperCase().replace(/\s+/g, "");
}
