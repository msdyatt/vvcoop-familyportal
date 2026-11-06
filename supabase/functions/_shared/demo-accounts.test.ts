/// <reference lib="deno.ns" />
import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@1";
import { createOrResetDemoAccounts, DEMO_ACCOUNTS, generatePassword, removeDemoAccounts } from "./demo-accounts.ts";

function fakeAdmin(existing: Record<string, string> = {}) {
  const calls = { created: [] as string[], reset: [] as string[], seeded: null as unknown, removedRpc: 0, deletedUsers: [] as string[] };
  let n = 0;
  const client = {
    from: () => ({ select: () => ({ eq: (_c: string, email: string) => ({ maybeSingle: () => Promise.resolve({ data: existing[email] ? { id: existing[email] } : null }) }) }) }),
    rpc: (name: string, args?: unknown) => {
      if (name === "seed_demo_data") calls.seeded = args;
      if (name === "remove_demo_data") { calls.removedRpc += 1; return Promise.resolve({ data: ["library/a/full.jpg"], error: null }); }
      if (name === "erase_account_data") return Promise.resolve({ data: { email: null, storage_paths: [], households_deleted: [], households_without_adults: [] }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    storage: { from: () => ({ remove: () => Promise.resolve({ data: null, error: null }) }) },
    auth: { admin: {
      createUser: ({ email }: { email: string }) => { calls.created.push(email); n += 1; return Promise.resolve({ data: { user: { id: `new-${n}` } }, error: null }); },
      updateUserById: (id: string) => { calls.reset.push(id); return Promise.resolve({ error: null }); },
      deleteUser: (id: string) => { calls.deletedUsers.push(id); return Promise.resolve({ error: null }); },
    } },
  };
  return { client: client as never, calls };
}

Deno.test("generatePassword: four groups of five unambiguous characters, different each time", () => {
  const a = generatePassword();
  assertMatch(a, /^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
  assertEquals(/[0OIl1]/.test(a), false);
  assertNotEquals(a, generatePassword());
});

Deno.test("createOrReset: creates both accounts, seeds the sample world with their ids, returns each password once", async () => {
  const { client, calls } = fakeAdmin();
  const result = await createOrResetDemoAccounts(client);
  assertEquals(result.ok, true);
  assertEquals(calls.created, DEMO_ACCOUNTS.map((a) => a.email));
  assertEquals(calls.seeded, { p_parent: "new-1", p_teacher: "new-2" });
  if (result.ok) {
    assertEquals(result.accounts.map((a) => a.role), ["parent", "teacher"]);
    assertNotEquals(result.accounts[0].password, result.accounts[1].password);
  }
});

Deno.test("createOrReset: existing accounts get new passwords instead of being created again", async () => {
  const { client, calls } = fakeAdmin({ [DEMO_ACCOUNTS[0].email]: "p-id", [DEMO_ACCOUNTS[1].email]: "t-id" });
  const result = await createOrResetDemoAccounts(client);
  assertEquals(result.ok, true);
  assertEquals(calls.created.length, 0);
  assertEquals(calls.reset, ["p-id", "t-id"]);
  assertEquals(calls.seeded, { p_parent: "p-id", p_teacher: "t-id" });
});

Deno.test("remove: clears the sample world, then deletes both accounts", async () => {
  const { client, calls } = fakeAdmin({ [DEMO_ACCOUNTS[0].email]: "p-id", [DEMO_ACCOUNTS[1].email]: "t-id" });
  const result = await removeDemoAccounts(client);
  assertEquals(result, { ok: true, removed: 2 });
  assertEquals(calls.removedRpc, 1);
  assertEquals(calls.deletedUsers, ["p-id", "t-id"]);
});
