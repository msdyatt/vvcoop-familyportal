/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { manageInvitation, type SendInviteEmail } from "./invitations.ts";

/**
 * A tiny in-memory stand-in for the Supabase client: just the calls
 * manageInvitation makes, with the cascades the real schema has (deleting an
 * account removes its profile, memberships and roles; deleting a household
 * removes its invitations).
 *
 * These are the destructive paths -- delete a pending account, delete a
 * household -- so what they must NEVER do is pinned down here.
 */
type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

function fakeClient(db: Db, authUsers: AuthUsers) {
  const calls = { generateLink: 0, deleteUser: [] as string[] };

  class Query {
    private filters: ((row: Row) => boolean)[] = [];
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: Row = {};
    private head = false;
    constructor(private table: string) {}
    select(_columns?: string, options?: { count?: string; head?: boolean }) { this.head = Boolean(options?.head); return this; }
    insert(row: Row) { this.op = "insert"; this.payload = row; return this; }
    update(row: Row) { this.op = "update"; this.payload = row; return this; }
    delete() { this.op = "delete"; return this; }
    eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
    neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
    private matching() { return (db[this.table] ??= []).filter((row) => this.filters.every((fn) => fn(row))); }
    maybeSingle() { return Promise.resolve({ data: this.matching()[0] ?? null, error: null }); }
    // deno-lint-ignore no-explicit-any
    then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
      const rows = this.matching();
      let result: Row;
      if (this.op === "insert") { (db[this.table] ??= []).push(this.payload); result = { error: null }; }
      else if (this.op === "update") { for (const row of rows) Object.assign(row, this.payload); result = { error: null }; }
      else if (this.op === "delete") {
        db[this.table] = db[this.table].filter((row) => !rows.includes(row));
        if (this.table === "families") {
          const gone = new Set(rows.map((row) => row.id));
          db.invitations = (db.invitations ?? []).filter((row) => !gone.has(row.family_id));
        }
        result = { error: null };
      } else result = this.head ? { count: rows.length, data: null, error: null } : { data: rows, error: null };
      return Promise.resolve(result).then(resolve, reject);
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    auth: {
      admin: {
        getUserById: (id: string) => Promise.resolve({ data: { user: authUsers[id] ? { id, ...authUsers[id] } : null } }),
        deleteUser: (id: string) => {
          calls.deleteUser.push(id);
          delete authUsers[id];
          for (const table of ["profiles", "family_members", "user_roles"]) db[table] = db[table].filter((row) => (row.id ?? row.user_id) !== id);
          return Promise.resolve({ error: null });
        },
        generateLink: () => { calls.generateLink += 1; return Promise.resolve({ data: { properties: { action_link: "https://example.test/accept?t=fresh" } }, error: null }); },
      },
    },
  };
  return { client: client as never, calls };
}

const past = "2020-01-01T00:00:00.000Z";

type AuthUsers = Record<string, { email_confirmed_at: string | null; last_sign_in_at: string | null; user_metadata?: Row }>;

function world() {
  const db: Db = {
    invitations: [{ id: "inv-1", email: "pat@example.test", family_id: "fam-1", accepted_at: null, expires_at: past }],
    profiles: [{ id: "u-pat", email: "pat@example.test", display_name: "Pat Smith" }],
    families: [{ id: "fam-1", display_name: "Smith", last_name: "Smith" }],
    family_members: [{ family_id: "fam-1", user_id: "u-pat" }],
    user_roles: [{ user_id: "u-pat", role: "parent" }],
    children: [],
    audit_log: [],
  };
  const users: AuthUsers = { "u-pat": { email_confirmed_at: null, last_sign_in_at: null, user_metadata: { note: "Welcome!" } } };
  return { db, users };
}

const sent: Parameters<SendInviteEmail>[1][] = [];
const send: SendInviteEmail = (_admin, opts) => { sent.push(opts); return Promise.resolve({ ok: true }); };
const body = async (response: Response) => await response.json();

Deno.test("delete: a pending new household goes entirely -- account, membership, household, invitation", async () => {
  const { db, users } = world();
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals(response.status, 200);
  assertEquals(await body(response), { ok: true, accountRemoved: true, householdRemoved: true });
  assertEquals(calls.deleteUser, ["u-pat"]);
  assertEquals(db.families.length, 0);
  assertEquals(db.invitations.length, 0);
  assertEquals(db.audit_log[0].action, "invitation_deleted");
});

Deno.test("delete: a household with children is never removed", async () => {
  const { db, users } = world();
  db.children = [{ id: "kid-1", family_id: "fam-1" }];
  const { client } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals((await body(response)).householdRemoved, false);
  assertEquals(db.families.length, 1);
  assertEquals(db.children.length, 1);
  assertEquals(db.invitations.length, 0);
});

Deno.test("delete: a household with another adult in it is never removed", async () => {
  const { db, users } = world();
  db.family_members.push({ family_id: "fam-1", user_id: "u-sam" });
  const { client } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals(await body(response), { ok: true, accountRemoved: true, householdRemoved: false });
  assertEquals(db.families.length, 1);
  assertEquals(db.family_members.length, 1);
});

Deno.test("delete: someone who has already signed in is refused and nothing is touched", async () => {
  const { db, users } = world();
  users["u-pat"].last_sign_in_at = "2026-01-01T00:00:00.000Z";
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals(response.status, 409);
  assertEquals(calls.deleteUser.length, 0);
  assertEquals(db.invitations.length, 1);
  assertEquals(db.families.length, 1);
});

Deno.test("delete: an accepted invitation is refused", async () => {
  const { db, users } = world();
  db.invitations[0].accepted_at = "2026-01-01T00:00:00.000Z";
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals(response.status, 409);
  assertEquals(calls.deleteUser.length, 0);
});

Deno.test("delete: an account that also holds another role keeps its account; only the invitation goes", async () => {
  const { db, users } = world();
  db.user_roles.push({ user_id: "u-pat", role: "teacher" });
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals((await body(response)).accountRemoved, false);
  assertEquals(calls.deleteUser.length, 0);
  assertEquals(db.profiles.length, 1);
  assertEquals(db.invitations.length, 0);
});

Deno.test("delete: an account that belongs to a second household keeps its account", async () => {
  const { db, users } = world();
  db.family_members.push({ family_id: "fam-2", user_id: "u-pat" });
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "delete", "inv-1", send);
  assertEquals((await body(response)).accountRemoved, false);
  assertEquals(calls.deleteUser.length, 0);
});

Deno.test("delete: an unknown invitation is a 404", async () => {
  const { db, users } = world();
  const { client } = fakeClient(db, users);
  assertEquals((await manageInvitation(client, "admin-1", "delete", "nope", send)).status, 404);
  assertEquals((await manageInvitation(client, "admin-1", "delete", undefined, send)).status, 400);
});

Deno.test("resend: sends a fresh link, extends the expiry, and records it", async () => {
  sent.length = 0;
  const { db, users } = world();
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "resend", "inv-1", send);
  assertEquals(response.status, 200);
  assertEquals(calls.generateLink, 1);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, "pat@example.test");
  assert(sent[0].html.includes("https://example.test/accept?t=fresh"));
  assert(sent[0].html.includes("Welcome!"), "the original personal note is kept");
  assert(new Date(db.invitations[0].expires_at as string).getTime() > Date.now(), "expiry moved into the future");
  assertEquals(db.audit_log[0].action, "invitation_resent");
});

Deno.test("resend: someone who has already signed in gets no email", async () => {
  sent.length = 0;
  const { db, users } = world();
  users["u-pat"].email_confirmed_at = "2026-01-01T00:00:00.000Z";
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "resend", "inv-1", send);
  assertEquals(response.status, 409);
  assertEquals(calls.generateLink, 0);
  assertEquals(sent.length, 0);
});

Deno.test("resend: if the pending account was removed, it asks for a new invitation instead of creating a stray one", async () => {
  sent.length = 0;
  const { db, users } = world();
  db.profiles = [];
  const { client, calls } = fakeClient(db, users);
  const response = await manageInvitation(client, "admin-1", "resend", "inv-1", send);
  assertEquals(response.status, 404);
  assertEquals(calls.generateLink, 0);
  assertFalse(sent.length > 0);
});

Deno.test("resend: a failed email is reported as a warning, not a silent success", async () => {
  const { db, users } = world();
  const { client } = fakeClient(db, users);
  const failing: SendInviteEmail = () => Promise.resolve({ ok: false, error: "Resend returned 500" });
  const result = await body(await manageInvitation(client, "admin-1", "resend", "inv-1", failing));
  assert(String(result.warning).includes("could not be sent"));
});
