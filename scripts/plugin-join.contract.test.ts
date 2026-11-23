/**
 * `ovis join` against this PC's own server (server/index.ts on a state folder of its own and a free port) and the test
 * account service it uses: the invite is redeemed with the PC's own proof (POST /api/account/pc-proof), and the PC binds
 * itself through the same one press as `ovis add` (POST /api/account/one-press, which asks POST /v1/pc/admission). The
 * relay of that harness never comes online, so the command alone is told it is once the PC is in the account (GET
 * /api/relay). No test sleeps: the waits between asks end at once.
 */
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";

import { pairingPc, type Pc } from "../server/account/pairing.test-helpers.ts";
import { bounded } from "../server/relay/test-helpers.ts";
import { handleRelayRequest } from "../server/relay/routes.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { join, JOIN_EXIT } from "./plugin-join.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

const OWNER = "acct_owner";
const SERVICE = "https://account.test";

async function fresh(): Promise<Pc> {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  made.account.opensAll = true;
  pcs.push(made);
  return made;
}

async function inviteFor(made: Pc, auto = false): Promise<string> {
  const response = await made.account.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${made.account.issueToken(OWNER)}` }, body: JSON.stringify(auto ? { auto: true } : {}) }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { invite: string }).invite;
}

/** Every file this PC keeps, read whole. */
function stateFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => joinPath(dir, name)).filter((path) => statSync(path).isFile()).map((path) => readFileSync(path, "latin1"));
}

/**
 * `ovis join --account OWNER --json` as an agent runs it, with no terminal. `heard` sees each line it says on stderr, and
 * may press Add on a device of the account (`press`) or stop the run (`stop`).
 */
async function joining(made: Pc, line: string, heard: (text: string, act: { press: () => void; stop: () => void }) => void = () => undefined) {
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  const stop = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  const asked: number[] = [];
  const waiting: unknown[] = [];
  let pressed: Promise<Response> | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: made.devices.account() === null ? "connecting" : "online", blocked: null });
    const body = request.method === "POST" ? await request.clone().text() : "";
    const response = await globalThis.fetch(request);
    if (path === "/api/account/one-press" && body !== "{}") {
      asked.push(response.status);
      waiting.push((await made.status()).waiting_for_add);
    }
    return response;
  };
  const act = {
    press: () => {
      pressed ??= made.account.fetch(new Request(`${SERVICE}/v1/pcs/${serverId}/admit`, { method: "POST", headers: { authorization: `Bearer ${made.account.issueToken(OWNER)}` }, body: "{}" }));
    },
    stop: () => stop.abort(),
  };
  const code = await bounded(join(["--invite-file", "/invite", "--account", OWNER, "--json"], {
    origin: `http://127.0.0.1:${made.app.port}`, headers: {}, fetch, accountService: SERVICE, serviceFetch: made.account.fetch, signal: stop.signal,
    lines: { next: () => new Promise(() => {}) }, terminal: false, isTty: false, running: true, platform: "linux",
    wait: (_ms, signal) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else setTimeout(resolve, 0); }),
    readFile: () => `${line}\n`, readStdin: async () => "",
    out: (text) => out.push(text),
    err: (text) => { err.push(text); heard(text, act); },
  }));
  return { code, out: out.join(""), err: err.join(""), asked, waiting, serverId, pressed: pressed as Promise<Response> | null };
}

test("a plain invite: the PC lists itself on its own proof, waits for Add on a device of the account, takes that admission and is in the account; the invite is in none of its files", async () => {
  const made = await fresh();
  const line = await inviteFor(made);
  const run = await joining(made, line, (text, act) => { if (text.includes("press Add for")) act.press(); });
  expect((await run.pressed)?.status).toBe(200);
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({ ok: true, account: OWNER, added: true, waiting: false, online: true });
  expect(made.devices.account()).toBe(OWNER);
  expect(made.account.pcs(OWNER).map((entry) => [entry.server_id, entry.listed_by_device])).toEqual([[run.serverId, false]]);
  // the PC said it waits for Add while no admission was there, and not once it was in
  expect(run.waiting.slice(0, -1).every((said) => said === true)).toBe(true);
  expect(run.waiting.at(-1)).toBe(false);
  expect((await made.status()).waiting_for_add).toBe(false);
  const secret = line.split(":").at(-1)!;
  for (const text of [run.out, run.err, ...stateFiles(made.stateDir)]) expect(text.includes(secret) || text.includes("ovis-invite:")).toBe(false);
});

test("an auto invite: the PC is in the account at once, with no Add", async () => {
  const made = await fresh();
  const line = await inviteFor(made, true);
  const run = await joining(made, line);
  expect(run.code).toBe(0);
  expect(run.asked).toEqual([200]);
  expect(made.devices.account()).toBe(OWNER);
  const secret = line.split(":").at(-1)!;
  for (const text of stateFiles(made.stateDir)) expect(text.includes(secret)).toBe(false);
});

test("stopped while it waits, the PC takes itself off the account's list by its own proof, and keeps nothing of the invite", async () => {
  const made = await fresh();
  const line = await inviteFor(made);
  const run = await joining(made, line, (text, act) => { if (text.includes("Waiting…")) setTimeout(act.stop, 0); });
  expect(run.code).toBe(JOIN_EXIT.stopped);
  expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: "stopped", listed: false });
  expect(made.devices.account()).toBeNull();
  expect(made.account.pcs(OWNER)).toEqual([]);
  const secret = line.split(":").at(-1)!;
  for (const text of [run.out, run.err, ...stateFiles(made.stateDir)]) expect(text.includes(secret)).toBe(false);
});

test("past a plain invite's ten minutes this PC answers one press with listing_expired, not as an account service that does not answer", async () => {
  const made = await fresh();
  const line = await inviteFor(made);
  const identity = made.app.context.services.relay.currentIdentity()!;
  const proof = await made.local("/api/account/pc-proof", { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, body: {} });
  const offer = await made.local("/api/relay/link", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-local-only": "1" } });
  expect(offer.status).toBe(200);
  const redeemed = await made.account.fetch(new Request(`${SERVICE}/v1/pc-invites/redeem`, { method: "POST", body: JSON.stringify({
    invite: line, server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.test", label: "PC",
    challenge_id: proof.body.challenge_id, proof: proof.body.proof,
  }) }));
  expect(redeemed.status).toBe(200);
  const named = await made.local("/api/account/relay-account", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: OWNER } });
  expect(named.status).toBe(204);
  const press = () => made.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, body: { account: OWNER } });
  expect((await press()).body.error?.code).toBe("no_admission");
  expect((await made.status()).waiting_for_add).toBe(true);
  // the service's clock moves past the card's ten minutes
  const later = Date.now() + 11 * 60_000;
  Object.assign(made.account, { now: () => later });
  const expired = await press();
  expect([expired.status, expired.body.error?.code]).toEqual([409, "listing_expired"]);
  expect((await made.status()).waiting_for_add).toBe(false);
});

test("GET /api/relay names this PC's ID to its own window and CLI only", async () => {
  const made = await fresh();
  const own = await made.local("/api/relay");
  expect(own.body.server_id).toBe(made.app.context.services.relay.currentIdentity()!.server_id);
  const other = await handleRelayRequest(new Request(`http://127.0.0.1:${made.app.port}/api/relay`), "/api/relay", made.app.context, "0123456789abcdef", false, false);
  expect(Object.keys(await other.json() as object)).not.toContain("server_id");
});
