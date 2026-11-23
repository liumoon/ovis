import { describe, expect, it } from "bun:test";

import { parsePcInvite } from "./pc-invite.ts";

/** 32 random bytes as the account service writes them: base64url, no padding. */
const secret = (): string => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("a PC invite line", () => {
  it("names its account, for any 32 bytes of secret", () => {
    for (let round = 0; round < 64; round++) {
      const made = secret();
      expect(made).toHaveLength(43);
      expect(parsePcInvite(`ovis-invite:1:acct_1a2b-C3:${made}`)).toEqual({ account: "acct_1a2b-C3", secret: made });
    }
    expect(parsePcInvite(`ovis-invite:1:${"a".repeat(64)}:${"A".repeat(43)}`)?.account).toBe("a".repeat(64));
  });

  it("takes nothing else: another prefix or version, the account list's join line, a secret of another length or last character, any space", () => {
    const good = `${"A".repeat(42)}w`;
    for (const line of [
      "",
      `ovis-join:1:acct_1:${good}`,
      `ovis-invite:2:acct_1:${good}`,
      `OVIS-INVITE:1:acct_1:${good}`,
      `ovis-invite:1::${good}`,
      `ovis-invite:1:${"a".repeat(65)}:${good}`,
      `ovis-invite:1:acct.1:${good}`,
      `ovis-invite:1:acct_1:${"A".repeat(42)}`,
      `ovis-invite:1:acct_1:${"A".repeat(44)}`,
      // the last of 43 characters carries two bits: B is not one of them
      `ovis-invite:1:acct_1:${"A".repeat(42)}B`,
      `ovis-invite:1:acct_1:${"A".repeat(41)}=w`,
      `ovis-invite:1:acct_1:${good}=`,
      ` ovis-invite:1:acct_1:${good}`,
      `ovis-invite:1:acct_1:${good}\n`,
      `ovis-invite:1:acct_1:${good}:extra`,
    ]) expect([line, parsePcInvite(line)]).toEqual([line, null]);
  });
});
