/**
 * `ovis join`: a new PC joins an Ovis account with a single-use invite that a device signed in to that account made
 * (docs/relay.md, "A PC with no screen"; docs/account.md, "PC invites"), with no sign-in on the PC. The person at the PC
 * sees which account the invite is for and types yes (or names it with `--account`) before anything is sent: an
 * invite someone else handed over must not attach this PC, and so a terminal on it, to their account unseen. Then the
 * PC lists itself in that account on its own key's proof (POST /v1/pc-invites/redeem), and from there it is `ovis add`
 * (plugin-link.ts addByPress): a plain invite waits for Add on a device of the account, an auto invite is admitted at
 * once, and this PC takes that admission and binds itself through the same route.
 *
 * The invite line is a key to the account's list for 15 minutes: it is never printed, logged or written anywhere, and
 * goes to the account service alone. A line on the command line shows in the process list, so the help and the docs
 * name the file and standard input forms first.
 */
import { accountOsOfPlatform } from "../shared/account-asker.ts";
import { parsePcInvite } from "../shared/pc-invite.ts";
import { isLoopbackHost } from "../server/access.ts";
import { shortAccount } from "./plugin-cli.ts";
import {
  addByPress, askLine, AwayError, cli, LocalError, localApi, openedListing, plainLabel, relayOn, takesPress,
  type Api, type LinkOptions, type PressEnd, type PressWords, type Unlisted,
} from "./plugin-link.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Each way `ovis join` ends, by the name `--json` gives it, and its exit code (docs/relay.md, "ovis join"). */
export const JOIN_EXIT = {
  ok: 0,
  not_added: 1,
  stopped: 1,
  usage: 2,
  invite_invalid: 3,
  not_confirmed: 4,
  account_mismatch: 5,
  other_account: 6,
  rate_limited: 7,
  pc_add_cap: 8,
  directory_full: 9,
  service_unreachable: 10,
  not_available: 11,
  relay_unavailable: 12,
  not_running: 13,
  no_add: 14,
} as const;

export type JoinError = Exclude<keyof typeof JOIN_EXIT, "ok">;

export interface JoinOptions extends LinkOptions {
  /** standard error: everything but the JSON object with `--json` */
  readonly err: (text: string) => void;
  /** the Ovis on this PC answered its health check */
  readonly running: boolean;
  /** OVIS_INVITE, read only when no other form names the invite */
  readonly inviteEnv?: string;
  readonly readFile: (path: string) => string;
  readonly readStdin: () => Promise<string>;
  readonly platform?: string;
}

/** An invite read from a file or standard input is a line: anything longer is not one. */
export const INVITE_READ_MAX = 4096;

const ACCOUNT_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

type Source = { readonly kind: "arg"; readonly text: string } | { readonly kind: "file"; readonly path: string } | { readonly kind: "stdin" } | { readonly kind: "env" };

/**
 * The words after `ovis join`. A refusal never repeats a word that is not a flag: any of them may be the invite.
 */
export function parseJoinArgs(args: readonly string[], command = "ovis join"): { readonly source: Source | null; readonly account?: string; readonly json: boolean } | { readonly error: string } {
  const sources: Source[] = [];
  let account: string | undefined;
  let json = false;
  const valued = (index: number, name: string): string | null => {
    const arg = args[index]!;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    const next = args[index + 1];
    return next === undefined || next === "" || next.startsWith("-") && next !== "-" ? null : next;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "-") { sources.push({ kind: "stdin" }); continue; }
    for (const name of ["--account", "--invite-file"] as const) {
      if (arg !== name && !arg.startsWith(`${name}=`)) continue;
      const value = valued(index, name);
      if (value === null || value === "") return { error: `${command}: ${name} needs a value` };
      if (arg === name) index++;
      if (name === "--account") {
        if (!ACCOUNT_SHAPE.test(value)) return { error: `${command}: --account takes the id of the Ovis account the invite is for (letters, digits, _ and -)` };
        account = value;
      } else sources.push({ kind: "file", path: value });
    }
    if (arg === "--account" || arg.startsWith("--account=") || arg === "--invite-file" || arg.startsWith("--invite-file=")) continue;
    // a flag's name is no invite (an invite never starts with -), so it may be named back
    if (arg.startsWith("-")) return { error: `${command}: unknown flag ${/^-[-A-Za-z0-9]{0,40}$/.test(arg) ? arg : "(not shown)"}` };
    sources.push({ kind: "arg", text: arg });
  }
  if (sources.length > 1) return { error: `${command}: give the invite one way only: --invite-file <path>, - (standard input), or the invite itself` };
  return { source: sources[0] ?? null, ...account === undefined ? {} : { account }, json };
}

const USAGE_HINT = (command: string): string => `Run ${command} --invite-file <path> (or ${command} - to read it from standard input). ${command} --help says more.`;

const NOT_AN_INVITE = "That is not an Ovis PC invite: an invite is one line that starts with ovis-invite:1:, made on a device signed in to your account. Nothing was sent.";

const INVITE_DEAD = "This invite does not work: it is mistyped, used or expired (an invite works once, for 15 minutes). Ask for a new one.";

/** Seconds from a retry-after header, as a person reads them. */
function inTime(seconds: number | null): string {
  if (seconds === null) return "a while";
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds < 2 * 3600) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

interface Outcome {
  readonly code: number;
  readonly json: Record<string, unknown>;
}

const failed = (error: JoinError, message: string, extra: Record<string, unknown> = {}): Outcome & { readonly message: string } =>
  ({ code: JOIN_EXIT[error], message, json: { ok: false, error, message, ...extra } });

/** The answer of the account service to a redeem, or why there is none. */
type Redeemed = { readonly account: string; readonly listing: string; readonly auto: boolean } | (Outcome & { readonly message: string });

/** This PC's fresh proof that it is `serverId`, for the `account` role (POST /api/account/pc-proof): single use, a minute long. */
async function pcProof(api: Api, serverId: string, signal?: AbortSignal): Promise<{ challenge_id: string; proof: string }> {
  const proof = await api<{ server_id?: unknown; challenge_id?: unknown; proof?: unknown }>("POST", "/api/account/pc-proof", signal === undefined ? {} : { signal });
  if (proof.server_id !== serverId || typeof proof.challenge_id !== "string" || typeof proof.proof !== "string") throw new LocalError("The Ovis on this PC gave no proof that it is this PC.");
  return { challenge_id: proof.challenge_id, proof: proof.proof };
}

export async function join(args: readonly string[], options: JoinOptions): Promise<number> {
  const parsed = parseJoinArgs(args, `${cli(options)} join`);
  const json = "error" in parsed ? args.includes("--json") : parsed.json;
  // with --json, stdout carries the one object, and everything a person would read goes to stderr
  const say = json ? options.err : options.out;
  const end = (outcome: Outcome & { readonly message?: string }): number => {
    if (outcome.message !== undefined) say(`${outcome.message}\n`);
    if (json) options.out(`${JSON.stringify(outcome.json)}\n`);
    return outcome.code;
  };
  const command = `${cli(options)} join`;
  if ("error" in parsed) return end(failed("usage", `${parsed.error}\n${USAGE_HINT(command)}`));
  const source = parsed.source ?? ((options.inviteEnv ?? "") === "" ? null : { kind: "env" } as const);
  if (source === null) return end(failed("usage", `${command} needs the invite a device of your account made. ${USAGE_HINT(command)}`));
  let line: string;
  try {
    line = source.kind === "arg" ? source.text : source.kind === "env" ? options.inviteEnv ?? "" : source.kind === "file" ? options.readFile(source.path) : await options.readStdin();
  } catch {
    // never the path: it could be the invite itself, put where a path goes
    return end(failed("usage", source.kind === "file" ? "Could not read the file --invite-file names. Nothing was sent." : "Could not read the invite from standard input. Nothing was sent."));
  }
  const invite = line.length > INVITE_READ_MAX ? null : parsePcInvite(line.trim());
  if (invite === null) return end(failed("invite_invalid", NOT_AN_INVITE));
  const account = invite.account;
  if (parsed.account !== undefined && parsed.account !== account) {
    return end(failed("account_mismatch", `The invite is for Ovis account ${account}, not the one --account names (${parsed.account}). Nothing was sent, and the invite was not used.`));
  }
  let host: string;
  try { host = new URL(options.origin).host; } catch { host = ""; }
  if (!isLoopbackHost(host)) return end(failed("not_available", `The server at ${options.origin} is not on a loopback address. Run ${command} only on the PC itself, with Ovis listening on 127.0.0.1 (HOST unset).`));
  if (options.accountService === null) return end(failed("relay_unavailable", "The account service is off on this PC (OVIS_ACCOUNT_SERVICE_URL=off), so it joins no account. Nothing was sent."));
  if (!options.running) return end(failed("not_running", `Ovis is not running on this PC. Start it (${cli(options)} start, or open the app), then run this again.`));
  // the invite came on standard input, which is then no terminal anybody types at
  const terminal = source.kind !== "stdin" && options.terminal === true;
  const flow: LinkOptions = { ...options, out: say, terminal };
  const api = localApi(flow);
  try {
    return end(await joining(flow, api, { line: line.trim(), account, pinned: parsed.account !== undefined, json, platform: options.platform ?? process.platform }));
  } catch (error) {
    if (options.signal.aborted) return end(failed("stopped", "Stopped. Nothing of the invite was used here."));
    if (!(error instanceof LocalError || error instanceof AwayError)) throw error;
    return end(failed(error instanceof AwayError ? "not_running" : "not_added", `Could not add this PC: ${error instanceof LocalError ? error.reason : error.message}`));
  }
}

async function joining(options: LinkOptions, api: Api, invite: { readonly line: string; readonly account: string; readonly pinned: boolean; readonly json: boolean; readonly platform: string }): Promise<Outcome & { readonly message?: string }> {
  const { out, signal } = options;
  const { account } = invite;
  const service = options.accountService!;
  const serviceFetch: Fetch = options.serviceFetch ?? fetch;
  const wait = options.wait ?? ((ms: number, abort: AbortSignal) => new Promise<void>((resolve, reject) => {
    // fixed wait: a pause before asking the account service again, as it asked
    const timer = setTimeout(resolve, ms);
    abort.addEventListener("abort", () => { clearTimeout(timer); reject(abort.reason); }, { once: true });
  }));
  const command = `${cli(options)} join`;
  let status: { account: string | null };
  try { status = await api<{ account: string | null }>("GET", "/api/account/status"); } catch (error) {
    if (error instanceof LocalError && error.status === 404) return failed("not_available", `The Ovis running on this PC is older than ${command} needs. Update it in Settings → Updates, then run this again.`);
    throw error;
  }
  // in that account already: the invite is left for another PC
  if (status.account === account) {
    return { code: JOIN_EXIT.ok, message: `This PC is already in Ovis account ${account}. The invite was not used.`, json: { ok: true, account, added: false, waiting: false, online: null } };
  }
  if (status.account !== null) {
    return failed("other_account", `This PC is in another Ovis account (${shortAccount(status.account)}). Run ${cli(options)} logout to take it out of that one first, then run ${command} again. The invite was not used.`);
  }
  const takes = await takesPress(api);
  if (takes !== "press") {
    return failed("not_available", takes === "not-own"
      ? `The Ovis on this PC does not count this terminal as the PC itself (a forwarded port?), so it cannot be added from here. Run ${command} on the PC itself.`
      : `The Ovis on this PC cannot take an invite (its Step 2 is off, or it is older). Update it in Settings → Updates, then run this again.`);
  }
  // nothing has gone to the account service so far, and nothing goes before the person here said this is the account
  if (!invite.pinned) {
    if (options.terminal !== true || options.isTty !== true) {
      return failed("not_confirmed", `Not run in a terminal, so nobody here can confirm the account the invite is for. Run ${command} --account <the account's id> (Manage account in Settings shows it, and ${cli(options)} status on a PC already in it), or run ${command} in a terminal. Nothing was sent.`);
    }
    const asked = [
      `This invite adds this PC to Ovis account ${account}.`,
      "Compare this ID with Settings → Manage account → Account ID in your",
      `Ovis app, or with ${cli(options)} status on a PC you already use.`,
      "Is this your account? Type yes to add this PC to it: ",
    ].join("\n");
    const answer = await askLine(options, asked);
    if (answer === null || answer.normalize("NFKC").trim().toLowerCase() !== "yes") {
      return failed("not_confirmed", "This PC was not added, and the invite was not used.");
    }
  } else out(`Ovis account ${account} is the one --account names.\n`);
  try { await relayOn(options, api); } catch (error) {
    if (!(error instanceof LocalError)) throw error;
    return failed("relay_unavailable", `${error.reason.replace(/[.\s]*$/, ".")} Nothing was sent.`);
  }
  const listing = await openedListing(api);
  const serverId = listing.serverId;
  const label = plainLabel(listing.entry.label).slice(0, 48) || serverId.slice(0, 8);
  // the window opening the listing opened takes digits approved here, which this way does not ask for (addByPress closes it too)
  const closeWindow = () => api("POST", "/api/relay/link/close", { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  const redeemed = await redeem();
  if (!("account" in redeemed)) {
    await closeWindow();
    return redeemed;
  }
  if (redeemed.account !== account) {
    await closeWindow();
    await leave(redeemed.account);
    return failed("not_added", "The account service answered for another account than the invite's. This PC was not added.");
  }
  // the account this PC's relay pass is asked under, and the only one its one press takes
  const named = () => api("POST", "/api/account/relay-account", { body: { account } }).then(() => undefined, () => undefined);
  await named();
  let ended: PressEnd | null = null;
  const code = await addByPress({ ...options, ...invite.json ? { terminal: false } : {} }, api, {
    signedIn: account, name: label, listedAt: null, confirmed: redeemed.auto,
    unlist: () => leave(account), named, signOut: async () => undefined,
    words: joinWords(options, account, redeemed.auto), report: (end) => { ended = end; },
  });
  const outcome = ended as PressEnd | null;
  if (outcome === null) return { code, json: code === 0 ? { ok: true, account, added: true, waiting: false, online: null } : { ok: false, error: "not_added", message: "This PC was not added." } };
  switch (outcome.kind) {
    case "added": return { code, json: { ok: true, account, added: true, waiting: false, online: outcome.online } };
    case "elsewhere": return { code: JOIN_EXIT.other_account, json: { ok: false, error: "other_account", message: `This PC joined another Ovis account (${shortAccount(outcome.account)}), not the one the invite is for.` } };
    case "not_added": {
      const error: JoinError = outcome.why === "timeout" ? "no_add" : outcome.why === "stopped" ? "stopped" : "not_added";
      const message = outcome.why === "timeout" ? "Nobody pressed Add for this PC within 10 minutes of its listing."
        : outcome.why === "stopped" ? "Stopped before this PC was added."
        : outcome.why === "none_waiting" ? "The invite's add was not there to take (it lasts 10 minutes from the invite's first use)."
        : "This PC was not added.";
      return { code: JOIN_EXIT[error], json: { ok: false, error, message, listed: outcome.listed } };
    }
  }

  /**
   * POST /v1/pc-invites/redeem with this PC's listing and a fresh proof of its key. A proof that lapsed on the way, or
   * the service's try_again, is asked again twice; a refusal is told by its name only, never by the service's words.
   */
  async function redeem(): Promise<Redeemed> {
    for (let attempt = 0; ; attempt++) {
      let proof: { challenge_id: string; proof: string };
      try { proof = await pcProof(api, serverId); } catch (error) {
        if (signal.aborted || !(error instanceof LocalError)) throw error;
        if (error.code === "account_unavailable") return failed("service_unreachable", "The account service did not answer this PC. Try again in a moment: the invite works for 15 minutes.");
        return failed("not_available", `The Ovis on this PC gave no proof that it is this PC (${error.reason.replace(/[.\s]*$/, "")}). Update it in Settings → Updates, then run this again.`);
      }
      const os = accountOsOfPlatform(invite.platform);
      let response: Response;
      try {
        // never redirected: the invite and the proof go to the account service alone
        response = await serviceFetch(`${service}/v1/pc-invites/redeem`, {
          method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          body: JSON.stringify({ invite: invite.line, server_id: serverId, public_key: listing.entry.public_key, relay: listing.entry.relay, label, ...os === null ? {} : { os }, ...proof }),
        });
      } catch {
        if (signal.aborted) {
          // the service may have taken the invite just as the run stopped: what it listed goes again
          const off = await leave(account);
          return failed("stopped", off === "removed" ? "Stopped. This PC is in no account, and the invite's account does not list it."
            : `Stopped. The invite's account may list this PC: run ${command} again with the same invite within its 15 minutes to finish, or remove it on a device of that account.`, { listed: off === "removed" ? false : null });
        }
        return failed("service_unreachable", "Could not reach the account service. Check this PC's internet connection and try again: the invite works for 15 minutes.");
      }
      let body: unknown = null;
      try { body = await response.json(); } catch {}
      if (response.status === 200) {
        const answer = body as { account?: unknown; listing_id?: unknown; auto?: unknown } | null;
        if (typeof answer?.account !== "string" || typeof answer.listing_id !== "string" || typeof answer.auto !== "boolean") return failed("not_added", "The account service sent an answer this command does not read. Update Ovis on this PC, then run this again.");
        return { account: answer.account, listing: answer.listing_id, auto: answer.auto };
      }
      const said = (body as { error?: { code?: unknown } } | null)?.error?.code;
      const code = typeof said === "string" && /^[a-z0-9_]{1,40}$/.test(said) ? said : null;
      if (attempt < 2 && ((response.status === 401 && code === "proof_invalid") || (response.status === 409 && code === "try_again"))) {
        await wait(1_000, signal);
        continue;
      }
      const header = Number(response.headers.get("retry-after"));
      const retryAfter = Number.isSafeInteger(header) && header >= 0 ? header : null;
      if (response.status === 400 && code === "invite_invalid") return failed("invite_invalid", INVITE_DEAD);
      if (response.status === 429 && code === "pc_add_cap") return failed("pc_add_cap", `Your Ovis account has added as many PCs as it may for now: try again in ${inTime(retryAfter)}. The invite was not used.`, { retry_after: retryAfter });
      if (response.status === 429) return failed("rate_limited", `The account service asks this PC to wait: try again in ${inTime(retryAfter)}.`, { retry_after: retryAfter });
      if (response.status === 409 && code === "directory_full") return failed("directory_full", `Your account holds as many PCs as it can. Remove one in the Ovis app, then run ${command} again (with a new invite once this one ran out).`);
      if (response.status === 404) return failed("not_available", `The account service takes no PC invites for this account. Add this PC with ${cli(options)} add instead.`);
      if (response.status >= 500) return failed("service_unreachable", `The account service did not answer this PC (HTTP ${response.status}). Try again in a moment: the invite works for 15 minutes.`);
      return failed("not_added", `The account service did not take this PC (${code ?? `HTTP ${response.status}`}). This PC was not added.`);
    }
  }

  /** Takes this PC off `from`'s list by its own proof (POST /v1/pcs/{server_id}/leave), on signals of its own: Ctrl+C aborted the run's. */
  async function leave(from: string): Promise<Unlisted> {
    try {
      const proof = await pcProof(api, serverId, AbortSignal.timeout(5_000));
      const left = await serviceFetch(`${service}/v1/pcs/${serverId}/leave`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ server_id: serverId, account: from, ...proof }),
      });
      return left.status === 204 ? "removed" : "failed";
    } catch { return "failed"; }
  }
}

/** `ovis join`'s words for the press: an invite chose the account, and nothing was signed in to. */
function joinWords(options: LinkOptions, account: string, auto: boolean): PressWords {
  const command = `${cli(options)} join`;
  return {
    command, anew: "Ask for a new invite to try again.", chosen: "the invite is for",
    closing: `Check: ${cli(options)} status      Undo: ${cli(options)} logout\n`,
    waiting: (name, lasts) => auto
      ? `This PC is listed in Ovis account ${account} as ${name}, and the invite adds it with no Add to press.\n`
      : `This PC is listed in Ovis account ${account} as ${name}. Open Ovis on your phone or another device signed in to that account and press Add for ${name} (its card shows for 10 minutes).\nWaiting… (up to ${lasts}, Ctrl+C to stop)\n`,
    noneWaiting: `The invite's add is no longer there to take: it lasts 10 minutes from the invite's first use. Ask for a new invite, then run ${command} again.\n`,
  };
}
