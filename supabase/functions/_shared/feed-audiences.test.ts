/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { personalFeedAudiences } from "./feed-audiences.ts";

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
