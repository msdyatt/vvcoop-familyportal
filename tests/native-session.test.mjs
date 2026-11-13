// What the page tells the iPhone app's native screens about the session (lib/native-session.ts):
// the access token and the public connection details, never the refresh token.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "native-session-"));
const source = await readFile(new URL("../lib/native-session.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
// The two imports only matter once a page is running in the frame; the message builder needs neither.
await writeFile(path.join(dir, "native-frame.mjs"), "export const nativeFrame = () => null;");
await writeFile(path.join(dir, "supabase.mjs"), "export const getSupabaseBrowserClient = () => null; export const supabaseConnection = () => ({});");
await writeFile(path.join(dir, "native-session.mjs"), outputText.replace('"./native-frame"', '"./native-frame.mjs"').replace('"./supabase"', '"./supabase.mjs"'));
const { sessionMessage, startNativeSession } = await import(pathToFileURL(path.join(dir, "native-session.mjs")).href);

const connection = { url: "https://project.example", key: "sb_publishable_x" };

test("a session becomes the access token and the public connection details", () => {
  const message = sessionMessage({ access_token: "jwt", refresh_token: "secret-refresh", expires_at: 1_900_000_000, expires_in: 3600, user: { id: "u1" } }, connection);
  assert.deepEqual(message, { signedIn: true, url: connection.url, key: connection.key, userId: "u1", accessToken: "jwt", expiresAt: 1_900_000_000 });
  assert.ok(!JSON.stringify(message).includes("secret-refresh"), "the refresh token stays in the web view");
});

test("with no expires_at, the expiry is worked out from expires_in", () => {
  const before = Math.floor(Date.now() / 1000);
  const message = sessionMessage({ access_token: "jwt", expires_in: 3600, user: { id: "u1" } }, connection);
  assert.ok(message.expiresAt >= before + 3600 && message.expiresAt <= before + 3601);
});

test("no session, or one without a user, is signed out", () => {
  assert.deepEqual(sessionMessage(null, connection), { signedIn: false });
  assert.deepEqual(sessionMessage({ access_token: "jwt" }, connection), { signedIn: false });
});

test("outside the iPhone frame it does nothing", () => {
  assert.equal(typeof startNativeSession(), "function");
});
