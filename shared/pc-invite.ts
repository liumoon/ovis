/**
 * A PC invite (docs/account.md, "PC invites"): the line a device signed in to an account makes for a new PC, which that
 * PC redeems with `ovis join` and no sign-in of its own. The account part names the account it joins and is not secret;
 * the secret is 32 random bytes, base64url without padding (so its last character carries only two bits). It works
 * once, for 15 minutes. `ovis-join:1:` (shared/account-list-join.ts) is another thing and never one of these.
 */
const PC_INVITE = /^ovis-invite:1:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;

/** How long an invite works, once. */
export const PC_INVITE_TTL_MS = 15 * 60_000;

/** The parts of an invite line exactly as the grammar has them (no whitespace trimmed here), or null for anything else. */
export function parsePcInvite(line: string): { readonly account: string; readonly secret: string } | null {
  const parts = PC_INVITE.exec(line);
  return parts === null ? null : { account: parts[1]!, secret: parts[2]! };
}
