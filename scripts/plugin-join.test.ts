/**
 * `ovis join` against a stand-in for this PC's own server whose account calls go to the test account service with this
 * PC's real key proofs (POST /api/account/pc-proof, and /api/account/one-press asking POST /v1/pc/admission), on a
 * clock the test moves. The invite routes are the account service's (shared/account-service-fake.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";

import { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey, importSecretKey } from "../shared/relay-e2ee.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { answerServerChallenge } from "../shared/relay-server-proof.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { join, JOIN_EXIT, parseJoinArgs } from "./plugin-join.ts";

const ORIGIN = "http://127.0.0.1:7317";
const SERVICE = "https://account.test";
const RELAY = "wss://relay.test";
const CLOSING = "Check: ovis status      Undo: ovis logout\n";
const HINT = "If your phone asks for six digits when you open old-desktop, run ovis approve on this PC and type them.\n";
const ASKED = [
  "This invite adds this PC to Ovis account acct_1.",
  "Compare this ID with Settings → Manage account → Account ID in your",
  "Ovis app, or with ovis status on a PC you already use.",
  "Is this your account? Type yes to add this PC to it: ",
].join("\n");

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function clock() {
  let now = Date.parse("2026-11-24T12:00:00Z");
  return {
    now: () => now,
    pass: (ms: number) => { now += ms; },
    wait: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += ms;
      signal.throwIfAborted();
    },
  };
}

/** Lines typed at a terminal: one typed while nothing reads goes to the next read, unless the terminal is emptied first. */
function keyboard() {
  let reader: ((line: IteratorResult<string>) => void) | null = null;
  const kept: string[] = [];
  return {
    lines: { next: () => { const line = kept.shift(); return line !== undefined ? Promise.resolve({ value: line, done: false as const }) : new Promise<IteratorResult<string>>((resolve) => { reader = resolve; }); } },
    type: (line: string) => { const resolve = reader; reader = null; if (resolve === null) kept.push(line); else resolve({ value: line, done: false }); },
    discard: () => { kept.length = 0; return true; },
  };
}

interface Run {
  readonly code: number;
  /** stdout and stderr, as written */
  readonly out: string;
  readonly err: string;
  readonly line: string;
  readonly service: FakeAccountService;
  readonly serverId: string;
  /** this PC's calls, as `METHOD /path` */
  readonly local: string[];
  /** the account service's calls, as `METHOD /path` */
  readonly calls: string[];
  /** what had been asked of the account service, and of this PC, when the question showed; null when it did not */
  readonly beforeQuestion: { readonly service: string[]; readonly local: string[] } | null;
  readonly pressed: string[];
  readonly listed: () => { server_id: string; listed_by_device?: boolean }[];
  /** the files this run's PC keeps, read whole */
  readonly stateDir: string;
}

interface Setup {
  /** the words after `ovis join`, which may carry the invite line */
  readonly args?: readonly string[] | ((line: string) => readonly string[]);
  /** the invite this run is given: made by a device of acct_1 by default, auto or plain */
  readonly auto?: boolean;
  readonly line?: (made: string) => string;
  readonly terminal?: boolean;
  readonly isTty?: boolean;
  /** typed at the account question; none typed when false */
  readonly confirm?: string | false;
  /** a device of the account presses Add as this PC asks for its admission the n-th time */
  readonly pressAfter?: number;
  /** Ctrl+C as this PC is asked for its admission the n-th time */
  readonly stopAt?: number;
  /** the account this PC is in as the run starts */
  readonly inAccount?: string;
  readonly running?: boolean;
  readonly blocked?: string;
  readonly prepare?: (service: FakeAccountService, time: ReturnType<typeof clock>) => Promise<void> | void;
  /** answers an account service call in the service's place */
  readonly serviceAnswer?: (path: string, request: Request) => Response | Promise<Response> | undefined;
  readonly inviteEnv?: string | ((line: string) => string);
  readonly stdin?: string;
  readonly service?: FakeAccountService;
  readonly time?: ReturnType<typeof clock>;
  readonly stateDir?: string;
}

async function joining(setup: Setup = {}): Promise<Run> {
  const stateDir = setup.stateDir ?? mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
  if (setup.stateDir === undefined) scratch.push(stateDir);
  const identity = loadRelayIdentity(stateDir);
  const time = setup.time ?? clock();
  const service = setup.service ?? new FakeAccountService(time.now);
  service.opensAll = true;
  await setup.prepare?.(service, time);
  const owner = service.issueToken("acct_1");
  const made = await service.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify(setup.auto ? { auto: true } : {}) }));
  const madeLine = ((await made.json()) as { invite: string }).invite;
  const line = setup.line?.(madeLine) ?? madeLine;
  const state = { account: setup.inAccount ?? null as string | null, named: null as string | null };
  const local: string[] = [];
  const calls: string[] = [];
  const pressed: string[] = [];
  const stop = new AbortController();
  const serviceFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    expect(new URL(request.url).origin).toBe(SERVICE);
    return await setup.serviceAnswer?.(path, request.clone()) ?? await service.fetch(request);
  };
  const prove = async () => {
    const challenge = await (await serviceFetch(`${SERVICE}/v1/pc/challenge`, { method: "POST", body: JSON.stringify({ server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)) }) })).json() as { challenge_id: string; frame: string };
    return { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof: answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key), { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id })! };
  };
  const refuse = (code: string, status: number) => Response.json({ error: { code, message: code } }, { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(ORIGIN);
    const path = url.pathname;
    local.push(`${request.method} ${path}`);
    if (path === "/api/account/status") return Response.json({ account: state.account, enrolling: false });
    if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: state.account === null ? "connecting" : "online", blocked: setup.blocked ?? null });
    if (path === "/api/relay/start") return Response.json({ phase: "connecting", blocked: null });
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
    if (path === "/api/relay/link/close") return Response.json({ ok: true });
    if (path === "/api/account/relay-account") { state.named = (await request.json() as { account: string }).account; return new Response(null, { status: 204 }); }
    if (path === "/api/account/pc-proof") return Response.json(await prove());
    if (path === "/api/account/one-press") {
      const body = await request.json() as { account?: unknown };
      if (typeof body.account !== "string") return refuse("invalid_account", 400);
      pressed.push(body.account);
      if (pressed.length === setup.stopAt) { stop.abort(); return refuse("no_admission", 404); }
      if (pressed.length === setup.pressAfter) {
        const admit = await service.fetch(new Request(`${SERVICE}/v1/pcs/${identity.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${service.issueToken("acct_1")}` }, body: "{}" }));
        expect(admit.status).toBe(200);
      }
      if (state.named !== body.account) return refuse("account_mismatch", 409);
      if (state.account !== null) return refuse("in_account", 409);
      const admitted = await serviceFetch(`${SERVICE}/v1/pc/admission`, { method: "POST", body: JSON.stringify({ ...await prove(), account: body.account, with_listing_id: true }) });
      if (admitted.status === 404) return refuse("no_admission", 404);
      if (!admitted.ok) {
        const code = ((await admitted.json()) as { error?: { code?: string } }).error?.code;
        return code === "listing_expired" ? refuse("listing_expired", 409) : refuse("account_unavailable", 503);
      }
      state.account = body.account;
      return Response.json({ account: state.account });
    }
    return refuse("not_found", 404);
  };
  const keys = keyboard();
  const out: string[] = [];
  const err: string[] = [];
  let beforeQuestion: Run["beforeQuestion"] = null;
  const heard = (text: string): void => {
    if (text.includes("Is this your account? Type yes")) {
      beforeQuestion ??= { service: [...calls], local: [...local] };
      if (setup.confirm !== false) { time.pass(2_000); keys.type(setup.confirm ?? "yes"); }
    }
  };
  const args = typeof setup.args === "function" ? setup.args(line) : setup.args ?? ["--invite-file", "/invite"];
  const inviteEnv = typeof setup.inviteEnv === "function" ? setup.inviteEnv(line) : setup.inviteEnv;
  const code = await join(args, {
    origin: ORIGIN, headers: {}, fetch, serviceFetch, accountService: SERVICE, now: time.now, wait: time.wait, signal: stop.signal,
    lines: keys.lines, discard: keys.discard, terminal: setup.terminal ?? true, isTty: setup.isTty ?? true, running: setup.running ?? true,
    ...inviteEnv === undefined ? {} : { inviteEnv },
    platform: "linux",
    readFile: (path) => { if (path !== "/invite") throw new Error("ENOENT"); return `${line}\n`; },
    readStdin: async () => setup.stdin ?? `  ${line}\n`,
    out: (text) => { out.push(text); heard(text); },
    err: (text) => { err.push(text); heard(text); },
  });
  return {
    code, out: out.join(""), err: err.join(""), line, service, serverId: identity.server_id, local, calls, beforeQuestion, pressed, stateDir,
    listed: () => service.pcs("acct_1").filter((entry) => entry.server_id === identity.server_id),
  };
}

/** Nothing this run wrote shows the invite, or its secret apart. */
function expectNoInvite(run: Run): void {
  const secret = run.line.split(":").at(-1)!;
  expect(secret.length).toBeGreaterThan(8);
  for (const text of [run.out, run.err]) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain("ovis-invite:");
  }
}

describe("ovis join: the invite", () => {
  it("is read from a file, standard input, the line on the command line or OVIS_INVITE, trimmed", async () => {
    const pinned = ["--account", "acct_1"];
    for (const [form, setup] of [
      ["a file", { args: ["--invite-file", "/invite", ...pinned] }],
      ["standard input", { args: ["-", ...pinned] }],
      ["the command line", { args: (line: string) => [line, ...pinned] }],
      ["OVIS_INVITE", { args: pinned, inviteEnv: (line: string) => ` ${line}\n` }],
    ] as const) {
      const run = await joining({ ...setup, terminal: false, isTty: false, pressAfter: 1 });
      expect([form, run.code]).toEqual([form, 0]);
      expect(run.calls).toContain("POST /v1/pc-invites/redeem");
      expectNoInvite(run);
    }
    // OVIS_INVITE only where no other form names one
    const both = await joining({ args: ["--invite-file", "/invite", ...pinned], inviteEnv: "ovis-invite:1:acct_2:x", terminal: false, isTty: false, pressAfter: 1 });
    expect(both.code).toBe(0);
  });

  it("refuses two ways at once, none, an unknown flag and a bad --account before anything is asked, never repeating a word that could be the invite", async () => {
    const line = `ovis-invite:1:acct_1:${"A".repeat(42)}w`;
    for (const [args, said] of [
      [[line, "--invite-file", "/invite"], "give the invite one way only"],
      [[line, line], "give the invite one way only"],
      [["-", "--invite-file", "/invite"], "give the invite one way only"],
      [[], "needs the invite a device of your account made"],
      [["--invite-file"], "--invite-file needs a value"],
      [["--force", line], "unknown flag --force"],
      [[`--account=${line}`, "--invite-file", "/invite"], "--account takes the id of the Ovis account the invite is for"],
    ] as const) {
      const run = await joining({ args });
      expect([args, run.code]).toEqual([args, JOIN_EXIT.usage]);
      expect(run.out).toContain(said);
      expect(run.out).not.toContain("A".repeat(42));
      expect(run.local).toEqual([]);
      expect(run.calls).toEqual([]);
    }
    const unread = await joining({ args: ["--invite-file", "/elsewhere"] });
    expect(unread.code).toBe(JOIN_EXIT.usage);
    expect(unread.out).toBe("Could not read the file --invite-file names. Nothing was sent.\n");
    expect(parseJoinArgs(["--json", "-", "--account=acct_1"])).toEqual({ source: { kind: "stdin" }, account: "acct_1", json: true });
  });

  it("refuses anything but an invite line, the account list's ovis-join:1: line among them, before any request", async () => {
    for (const line of [(made: string) => made.replace("ovis-invite:1:", "ovis-join:1:"), (made: string) => `${made}x`, (made: string) => made.slice(0, -1), () => "hello", (made: string) => made.replace(":1:", ":2:")]) {
      const run = await joining({ line });
      expect(run.code).toBe(JOIN_EXIT.invite_invalid);
      expect(run.out).toBe("That is not an Ovis PC invite: an invite is one line that starts with ovis-invite:1:, made on a device signed in to your account. Nothing was sent.\n");
      expect(run.local).toEqual([]);
      expect(run.calls).toEqual([]);
    }
  });
});

describe("ovis join: the account it joins", () => {
  it("asks at a terminal, naming the account, before anything goes to the account service; anything but yes ends it with the invite unused", async () => {
    for (const answer of ["y", "", "no", "yes please"]) {
      const run = await joining({ confirm: answer });
      expect([answer, run.code]).toEqual([answer, JOIN_EXIT.not_confirmed]);
      expect(run.out).toContain(ASKED);
      expect(run.out.endsWith("This PC was not added, and the invite was not used.\n")).toBe(true);
      // the invite was made; nothing went to the account service from this run
      expect(run.calls).toEqual([]);
      expect(run.local).toEqual(["GET /api/account/status", "POST /api/account/one-press"]);
      expect(run.listed()).toEqual([]);
      expectNoInvite(run);
    }
    const yes = await joining({ confirm: "ＹＥＳ", pressAfter: 1 });
    expect(yes.code).toBe(0);
    // what was asked before the question: this PC's account, and whether it takes a press (asked with no account)
    expect(yes.beforeQuestion).toEqual({ service: [], local: ["GET /api/account/status", "POST /api/account/one-press"] });
  });

  it("with --account, asks nothing when it is the invite's account, and sends nothing at all when it is another", async () => {
    const same = await joining({ args: ["--invite-file", "/invite", "--account", "acct_1"], pressAfter: 1 });
    expect(same.code).toBe(0);
    expect(same.out).not.toContain("Is this your account?");
    expect(same.out).toContain("Ovis account acct_1 is the one --account names.\n");
    for (const other of ["acct_2", "acct_10", "acct"]) {
      const run = await joining({ args: ["--invite-file", "/invite", `--account=${other}`] });
      expect([other, run.code]).toEqual([other, JOIN_EXIT.account_mismatch]);
      expect(run.out).toBe(`The invite is for Ovis account acct_1, not the one --account names (${other}). Nothing was sent, and the invite was not used.\n`);
      expect(run.local).toEqual([]);
      expect(run.calls).toEqual([]);
    }
  });

  it("refuses where nobody can type yes and no --account names the account, naming --account, with nothing sent", async () => {
    for (const [terminal, isTty] of [[false, false], [true, false], [false, true]] as const) {
      const run = await joining({ terminal, isTty });
      expect([terminal, isTty, run.code]).toEqual([terminal, isTty, JOIN_EXIT.not_confirmed]);
      expect(run.out).toContain("Not run in a terminal, so nobody here can confirm the account the invite is for. Run ovis join --account <the account's id>");
      expect(run.calls).toEqual([]);
    }
    // standard input that carried the invite is no terminal to type at
    const piped = await joining({ args: ["-"] });
    expect(piped.code).toBe(JOIN_EXIT.not_confirmed);
  });

  it("says so and redeems nothing when this PC is in that account already; refuses another account, naming logout", async () => {
    const same = await joining({ inAccount: "acct_1" });
    expect(same.code).toBe(0);
    expect(same.out).toBe("This PC is already in Ovis account acct_1. The invite was not used.\n");
    expect(same.calls).toEqual([]);
    // the invite is still good for another PC
    const json = await joining({ inAccount: "acct_1", args: ["--invite-file", "/invite", "--json"] });
    expect(JSON.parse(json.out)).toEqual({ ok: true, account: "acct_1", added: false, waiting: false, online: null });
    const other = await joining({ inAccount: "acct_other0000" });
    expect(other.code).toBe(JOIN_EXIT.other_account);
    expect(other.out).toBe("This PC is in another Ovis account (acct_other00). Run ovis logout to take it out of that one first, then run ovis join again. The invite was not used.\n");
    expect(other.calls).toEqual([]);
  });
});

describe("ovis join: adding this PC", () => {
  it("a plain invite lists this PC with its own proof, says to press Add, and waits for it as ovis add does; then the PC is bound and its relay online", async () => {
    const run = await joining({ pressAfter: 3 });
    expect(run.code).toBe(0);
    expect(run.out).toContain("This PC is listed in Ovis account acct_1 as old-desktop. Open Ovis on your phone or another device signed in to that account and press Add for old-desktop (its card shows for 10 minutes).\nWaiting… (up to 10:00, Ctrl+C to stop)\n");
    expect(run.out.endsWith(`Added. Open old-desktop from My PCs.\n${HINT}${CLOSING}`)).toBe(true);
    expect(run.pressed).toEqual(["acct_1", "acct_1", "acct_1"]);
    expect(run.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
    // listed by redeeming, with the label ovis add gives the PC; then named for its relay pass, and asked about the press
    expect(run.calls.filter((call) => !call.endsWith("/challenge"))).toEqual(["POST /v1/pc-invites/redeem", "POST /v1/pc/admission", "POST /v1/pc/admission", "POST /v1/pc/admission"]);
    expect(run.local).toContain("POST /api/relay/link/close");
    expect(run.local.indexOf("POST /api/account/relay-account")).toBeLessThan(run.local.lastIndexOf("POST /api/account/one-press"));
    expectNoInvite(run);
  });

  it("an auto invite is admitted at once: no Add to press, nothing to wait for", async () => {
    const run = await joining({ auto: true, args: ["--invite-file", "/invite", "--account", "acct_1"], terminal: false, isTty: false });
    expect(run.code).toBe(0);
    expect(run.pressed).toEqual(["acct_1"]);
    expect(run.out).toBe([
      "Ovis account acct_1 is the one --account names.\n",
      "This PC is listed in Ovis account acct_1 as old-desktop, and the invite adds it with no Add to press.\n",
      `Added. Open old-desktop from My PCs.\n${HINT}${CLOSING}`,
    ].join(""));
    expectNoInvite(run);
  });

  it("nobody pressing Add in 10 minutes takes this PC off the account's list again, with its own exit code", async () => {
    const run = await joining({ args: ["--invite-file", "/invite", "--json"] });
    expect(run.code).toBe(JOIN_EXIT.no_add);
    expect(run.code).not.toBe(JOIN_EXIT.invite_invalid);
    expect(run.err).toContain("Nobody pressed Add for old-desktop within 10 minutes of its listing. This PC was taken off your account's list; it is in no account. Ask for a new invite to try again.\n");
    expect(JSON.parse(run.out)).toEqual({ ok: false, error: "no_add", message: "Nobody pressed Add for this PC within 10 minutes of its listing.", listed: false });
    expect(run.calls).toContain(`POST /v1/pcs/${run.serverId}/leave`);
    expect(run.listed()).toEqual([]);
    expectNoInvite(run);
  });

  it("Ctrl+C while it waits takes this PC off the account's list, so no half-listed PC stays", async () => {
    const run = await joining({ stopAt: 2 });
    expect(run.code).toBe(JOIN_EXIT.stopped);
    expect(run.out.endsWith("Stopped. This PC was taken off your account's list; it is in no account. Ask for a new invite to try again.\n")).toBe(true);
    expect(run.listed()).toEqual([]);
    expectNoInvite(run);
  });

  it("run again with the same invite within its 15 minutes, finishes what a run that could not leave began", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const stateDir = mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
    scratch.push(stateDir);
    let line = "";
    // the first run stops, and its leave does not reach the account service
    const first = await joining({ service, time, stateDir, stopAt: 2, line: (made) => { line = made; return made; }, serviceAnswer: (path) => path.endsWith("/leave") ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : undefined });
    expect(first.code).toBe(JOIN_EXIT.stopped);
    expect(first.out).toContain("could not be taken off your account's list just now: choose No on its card on a device of your account, or run ovis join again.");
    expect(first.listed()).toHaveLength(1);
    time.pass(60_000);
    const again = await joining({ service, time, stateDir, line: () => line, pressAfter: 1 });
    expect(again.code).toBe(0);
    expect(again.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
    expectNoInvite(again);
  });

  it("with --json: one object on stdout at the end, every other word on stderr, and no watch for a first device even at a terminal", async () => {
    const run = await joining({ args: ["--json", "--invite-file", "/invite"], pressAfter: 1 });
    expect(run.code).toBe(0);
    expect(run.out.split("\n")).toHaveLength(2);
    expect(JSON.parse(run.out)).toEqual({ ok: true, account: "acct_1", added: true, waiting: false, online: true });
    expect(run.err).toContain(ASKED);
    expect(run.err).toContain("Added. Open old-desktop from My PCs.\n");
    expect(run.local).not.toContain("GET /api/relay/joins");
    expectNoInvite(run);
  });
});

describe("ovis join: what the account service says", () => {
  const plainly = (setup: Setup = {}) => joining({ args: ["--invite-file", "/invite", "--account", "acct_1", "--json"], terminal: false, isTty: false, ...setup });
  const answered = (code: string, status: number, headers: Record<string, string> = {}) => (path: string) =>
    path === "/v1/pc-invites/redeem" ? Response.json({ error: { code, message: `the service's own words ${code}` } }, { status, headers }) : undefined;

  it("an invite another PC used is the one invite_invalid, in its own words", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    let line = "";
    const first = await plainly({ service, time, pressAfter: 1, line: (made) => { line = made; return made; } });
    expect(first.code).toBe(0);
    const second = await plainly({ service, time, line: () => line });
    expect(second.code).toBe(JOIN_EXIT.invite_invalid);
    expect(JSON.parse(second.out)).toEqual({ ok: false, error: "invite_invalid", message: "This invite does not work: it is mistyped, used or expired (an invite works once, for 15 minutes). Ask for a new one." });
    expect(second.listed()).toEqual([]);
    expectNoInvite(second);
  });

  it("an invite past its 15 minutes is invite_invalid, and nothing stays listed", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const owner = service.issueToken("acct_1");
    const line = ((await (await service.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${owner}` }, body: "{}" }))).json()) as { invite: string }).invite;
    time.pass(15 * 60_000);
    const run = await plainly({ service, time, line: () => line });
    expect(run.code).toBe(JOIN_EXIT.invite_invalid);
    expect(run.listed()).toEqual([]);
    // the window the listing opened is closed again
    expect(run.local.at(-1)).toBe("POST /api/relay/link/close");
  });

  it("maps each refusal to its own exit code and name, in its own words, never the service's", async () => {
    for (const [setup, error, said] of [
      [{ serviceAnswer: answered("rate_limited", 429, { "retry-after": "60" }) }, "rate_limited", "The account service asks this PC to wait: try again in 60 seconds."],
      [{ serviceAnswer: answered("pc_add_cap", 429, { "retry-after": "18000" }) }, "pc_add_cap", "Your Ovis account has added as many PCs as it may for now: try again in 5 hours. The invite was not used."],
      [{ serviceAnswer: answered("directory_full", 409) }, "directory_full", "Your account holds as many PCs as it can. Remove one in the Ovis app, then run ovis join again (with a new invite once this one ran out)."],
      [{ serviceAnswer: answered("not_found", 404) }, "not_available", "The account service takes no PC invites for this account. Add this PC with ovis add instead."],
      [{ serviceAnswer: answered("internal", 500) }, "service_unreachable", "The account service did not answer this PC (HTTP 500). Try again in a moment: the invite works for 15 minutes."],
      [{ serviceAnswer: (path: string) => { if (path === "/v1/pc-invites/redeem") throw new TypeError("fetch failed"); return undefined; } }, "service_unreachable", "Could not reach the account service. Check this PC's internet connection and try again: the invite works for 15 minutes."],
      [{ serviceAnswer: answered("list_endpoint", 409) }, "not_added", "The account service did not take this PC (list_endpoint). This PC was not added."],
      [{ blocked: "serve_only" }, "relay_unavailable", "The Ovis relay cannot run here (serve_only). Nothing was sent."],
      [{ running: false }, "not_running", "Ovis is not running on this PC. Start it (ovis start, or open the app), then run this again."],
    ] as const) {
      const run = await plainly(setup as Setup);
      expect([error, run.code]).toEqual([error, JOIN_EXIT[error]]);
      const object = JSON.parse(run.out) as { ok: boolean; error: string; message: string; retry_after?: number };
      expect([error, object.ok, object.error, object.message]).toEqual([error, false, error, said]);
      expect(run.err.endsWith(`${said}\n`)).toBe(true);
      expect(run.err).not.toContain("the service's own words");
      if (error === "rate_limited") expect(object.retry_after).toBe(60);
      if (error === "pc_add_cap") expect(object.retry_after).toBe(18000);
      expect(run.listed()).toEqual([]);
      expectNoInvite(run);
    }
  });

  it("asks again, with a fresh proof, when its proof lapsed on the way or the service says try_again", async () => {
    let tries = 0;
    const run = await plainly({ pressAfter: 1, serviceAnswer: (path) => {
      if (path !== "/v1/pc-invites/redeem" || ++tries > 2) return undefined;
      return Response.json({ error: { code: tries === 1 ? "proof_invalid" : "try_again" } }, { status: tries === 1 ? 401 : 409 });
    } });
    expect(run.code).toBe(0);
    expect(run.calls.filter((call) => call === "POST /v1/pc-invites/redeem")).toHaveLength(3);
  });

  it("an account's daily PC adds used up answer an auto invite's redeem with pc_add_cap and its retry-after", async () => {
    const run = await plainly({ auto: true, prepare: async (service) => {
      // three PCs added in one press today
      for (let added = 0; added < 3; added++) {
        const other = mkdtempSync(joinPath(tmpdir(), "ovis-join-other-"));
        scratch.push(other);
        const pc = loadRelayIdentity(other);
        const owner = service.issueToken("acct_1");
        await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ label: "pc", public_key: bytesToHex(importPublicKey(pc.public_key)), relay: RELAY }) }));
        expect((await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${owner}` }, body: "{}" }))).status).toBe(200);
      }
    } });
    expect(run.code).toBe(JOIN_EXIT.pc_add_cap);
    expect((JSON.parse(run.out) as { retry_after: number }).retry_after).toBeGreaterThan(0);
  });

  it("the PC's ask past a plain invite card's ten minutes ends the wait, and takes the PC off the list", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const stateDir = mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
    scratch.push(stateDir);
    let line = "";
    // a first run that died outright left the listing; the next comes 11 minutes later, still within the invite's 15
    await joining({ service, time, stateDir, args: ["--invite-file", "/invite", "--account", "acct_1"], terminal: false, isTty: false, stopAt: 1, line: (made) => { line = made; return made; }, serviceAnswer: (path) => path.endsWith("/leave") ? Response.json({}, { status: 503 }) : undefined });
    time.pass(11 * 60_000);
    const run = await joining({ service, time, stateDir, args: ["--invite-file", "/invite", "--account", "acct_1", "--json"], terminal: false, isTty: false, line: () => line });
    expect(run.code).toBe(JOIN_EXIT.not_added);
    expect(run.err).toContain("Could not add this PC: listing_expired. This PC was taken off your account's list; it is in no account. Ask for a new invite to try again.\n");
    expect(run.listed()).toEqual([]);
  });
});
