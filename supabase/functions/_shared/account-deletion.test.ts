/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { deleteAccount } from "./account-deletion.ts";

function fakeAdmin(rpcResult: { data?: unknown; error?: { message: string } | null }, deleteError: { message: string } | null = null) {
  const log = { removed: [] as string[][], deleted: [] as string[] };
  const client = {
    rpc: () => Promise.resolve({ data: rpcResult.data ?? null, error: rpcResult.error ?? null }),
    storage: { from: () => ({ remove: (paths: string[]) => { log.removed.push(paths); return Promise.resolve({ data: null, error: null }); } }) },
    auth: { admin: { deleteUser: (id: string) => { log.deleted.push(id); return Promise.resolve({ error: deleteError }); } } },
  };
  return { client: client as never, log };
}

const ok = { data: { email: "a@b.test", storage_paths: ["x/1.jpg", "x/1.jpg", "x/2.jpg"], households_deleted: [], households_without_adults: ["Smith"] } };

Deno.test("deleteAccount: erases data, removes each file once, then deletes the sign-in", async () => {
  const { client, log } = fakeAdmin(ok);
  const result = await deleteAccount(client, "u1", false);
  assertEquals(result.ok, true);
  assertEquals(log.removed, [["x/1.jpg", "x/2.jpg"]]);
  assertEquals(log.deleted, ["u1"]);
  if (result.ok) assertEquals(result.outcome.householdsWithoutAdults, ["Smith"]);
});

Deno.test("deleteAccount: the last administrator is refused with a plain message, and nothing is touched", async () => {
  const { client, log } = fakeAdmin({ error: { message: "last_admin" } });
  const result = await deleteAccount(client, "u1", false);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 409);
    assertEquals((await result.response.json()).error.includes("only administrator"), true);
  }
  assertEquals(log.removed.length, 0);
  assertEquals(log.deleted.length, 0);
});

Deno.test("deleteAccount: if erasing the data fails, the sign-in is not deleted", async () => {
  const { client, log } = fakeAdmin({ error: { message: "boom" } });
  const result = await deleteAccount(client, "u1", false);
  assertEquals(result.ok, false);
  assertEquals(log.deleted.length, 0);
});

Deno.test("deleteAccount: a failed sign-in deletion is reported so the person can try again", async () => {
  const { client } = fakeAdmin(ok, { message: "auth down" });
  const result = await deleteAccount(client, "u1", false);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.response.status, 500);
});
