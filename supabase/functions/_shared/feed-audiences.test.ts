/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { feedIsDemo, personalFeedAllowed, personalFeedAudiences } from "./feed-audiences.ts";

const person = (roles: string[], extra: Partial<{ isDemo: boolean; active: boolean }> = {}) =>
  ({ roles: new Set(roles), isDemo: false, active: true, ...extra });

Deno.test("families and teachers never get admin-only events in their feed", () => {
  assertEquals(personalFeedAudiences(person(["parent"])), ["public", "families"]);
  assertEquals(personalFeedAudiences(person(["teacher", "parent"])), ["public", "families", "teachers"]);
});

Deno.test("an administrator's own feed includes them", () => {
  assertEquals(personalFeedAudiences(person(["admin", "parent"])), ["public", "families", "teachers", "admins"]);
});

Deno.test("a reviewer or inactive account with the admin role does not", () => {
  assertEquals(personalFeedAudiences(person(["admin"], { isDemo: true })).includes("admins"), false);
  assertEquals(personalFeedAudiences(person(["admin"], { active: false })).includes("admins"), false);
});

Deno.test("a personal feed link works only while the person is active (issue #199)", () => {
  assertEquals(personalFeedAllowed({ status: "active" }), true);
  for (const status of ["removed", "suspended", "pending", null, undefined]) {
    assertEquals(personalFeedAllowed({ status }), false);
  }
});

Deno.test("a reviewer account's feed reads only demo rows, everyone else's only real ones (issue #164)", () => {
  assertEquals(feedIsDemo({ is_demo: true }), true);
  assertEquals(feedIsDemo({ is_demo: false }), false);
  assertEquals(feedIsDemo({ is_demo: null }), false);
});
