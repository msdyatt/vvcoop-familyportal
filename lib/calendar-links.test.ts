/// <reference lib="deno.ns" />
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  calendarFeedUrl, calendarSubscribeUrl, DEFAULT_SITE_URL, googleCalendarAddUrl, normalizeSiteUrl,
} from "./calendar-links.ts";

const SITE = "https://family.veritasvillage.org";
const TOKEN = "11111111-2222-4333-8444-555555555555";

Deno.test("feed links use the co-op domain and never name Supabase", () => {
  const publicFeed = calendarFeedUrl("scope=public", SITE);
  assertEquals(publicFeed, "https://family.veritasvillage.org/calendar/feed?scope=public");
  assertEquals(calendarFeedUrl(`scope=personal&token=${TOKEN}`, SITE), `${SITE}/calendar/feed?scope=personal&token=${TOKEN}`);
  for (const url of [calendarFeedUrl("scope=public"), calendarSubscribeUrl("scope=public"), googleCalendarAddUrl("scope=public")]) {
    assertEquals(url.includes("supabase"), false, url);
  }
});

Deno.test("the default site is the production portal domain", () => {
  assertEquals(DEFAULT_SITE_URL, "https://family.veritasvillage.org");
  assertEquals(calendarFeedUrl("scope=public"), `${DEFAULT_SITE_URL}/calendar/feed?scope=public`);
});

Deno.test("webcal link is the same address with the webcal scheme", () => {
  assertEquals(calendarSubscribeUrl("scope=public", SITE), "webcal://family.veritasvillage.org/calendar/feed?scope=public");
  assertEquals(
    calendarSubscribeUrl(`scope=class&id=abc&token=${TOKEN}`, SITE),
    `webcal://family.veritasvillage.org/calendar/feed?scope=class&id=abc&token=${TOKEN}`,
  );
});

Deno.test("Google link wraps the full https feed URL, encoded", () => {
  const url = googleCalendarAddUrl(`scope=personal&token=${TOKEN}`, SITE);
  assertStringIncludes(url, "https://calendar.google.com/calendar/render?cid=");
  const cid = new URL(url).searchParams.get("cid");
  assertEquals(cid, `${SITE}/calendar/feed?scope=personal&token=${TOKEN}`);
});

Deno.test("a configured site URL is reduced to an origin; bad values fall back to the default", () => {
  assertEquals(normalizeSiteUrl("https://calendar.example.org/"), "https://calendar.example.org");
  assertEquals(normalizeSiteUrl("  https://calendar.example.org/some/path?x=1  "), "https://calendar.example.org");
  assertEquals(normalizeSiteUrl("http://localhost:3000"), "http://localhost:3000");
  assertEquals(normalizeSiteUrl("http://family.veritasvillage.org"), DEFAULT_SITE_URL);
  assertEquals(normalizeSiteUrl("javascript:alert(1)"), DEFAULT_SITE_URL);
  assertEquals(normalizeSiteUrl("not a url"), DEFAULT_SITE_URL);
  assertEquals(normalizeSiteUrl(""), DEFAULT_SITE_URL);
  assertEquals(normalizeSiteUrl(undefined), DEFAULT_SITE_URL);
});
