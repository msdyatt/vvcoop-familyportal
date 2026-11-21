import { assertEquals } from "jsr:@std/assert@1";
import { hasAdminPermission, permissionRefusal, type RpcClient } from "./admin-permissions.ts";

type Call = { name: string; args: unknown };

function fakeRpc(result: { data: unknown; error: unknown }, calls: Call[] = []): RpcClient {
  return { rpc: (name: string, args: unknown) => { calls.push({ name, args }); return Promise.resolve(result); } };
}

Deno.test("hasAdminPermission asks the database about that person", async () => {
  const calls: Call[] = [];
  assertEquals(await hasAdminPermission(fakeRpc({ data: true, error: null }, calls), "u1", "integrations"), true);
  assertEquals(calls, [{ name: "admin_has_permission", args: { p_user: "u1", p_permission: "integrations" } }]);
});

Deno.test("hasAdminPermission treats a refusal, an error or an odd answer as no", async () => {
  assertEquals(await hasAdminPermission(fakeRpc({ data: false, error: null }), "u1", "integrations"), false);
  assertEquals(await hasAdminPermission(fakeRpc({ data: null, error: { message: "boom" } }), "u1", "integrations"), false);
  assertEquals(await hasAdminPermission(fakeRpc({ data: "true", error: null }), "u1", "integrations"), false);
});

Deno.test("permissionRefusal matches the database wording", () => {
  assertEquals(permissionRefusal("manage_permissions"), 'Ask a board admin. This needs the "Admin permissions" permission.');
});
