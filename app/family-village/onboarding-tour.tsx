"use client";

import { useState } from "react";
import { tourSteps, type TourStepId } from "../../lib/onboarding";
import DetailModal from "./detail-modal";
import PushSection from "./push-section";

type Copy = { eyebrow: string; title: string; body: React.ReactNode };

function stepCopy(id: TourStepId, returning: boolean, native: boolean, openAccount: () => void): Copy {
  switch (id) {
    case "welcome":
      return {
        eyebrow: "Welcome", title: "Welcome to Family Village.",
        body: <p>This is the co-op&rsquo;s private home, on the web and in the app. Your children&rsquo;s classes, teacher notes, news and calendar, paperwork, messages, and photos are all here. It takes about a minute to look around.</p>,
      };
    case "household":
      return {
        eyebrow: "Your household", title: "Check your details.",
        body: <>
          <p>Make sure your phone number and emergency contact are right. Your children and their classes are on the Family page; if something there is wrong, tell an administrator.</p>
          <button type="button" className="ghost" onClick={openAccount}>Open my account details</button>
        </>,
      };
    case "messages":
      return {
        eyebrow: returning ? "New" : "Messages", title: "Message teachers and other families.",
        body: <>
          <p>Open <b>Messages</b> to talk with your child&rsquo;s teacher, with families in a class, or with the whole class at once.</p>
          <p>Messages are private to the people in the conversation. Administrators can&rsquo;t browse them; they only see a message if someone reports it. You can mute, block, or report from any conversation.</p>
        </>,
      };
    case "photos":
      return {
        eyebrow: returning ? "New" : "Photos", title: "A photo library that stays with us.",
        body: <>
          <p>Teachers add class photos to the <b>Photos</b> library instead of Facebook. Filter by school year, class, or album, and download what you need.</p>
          <p>Parents can submit photos too, and a teacher reviews them first. Only add photos you have permission to share, and report any that shouldn&rsquo;t be there.</p>
        </>,
      };
    case "notifications":
      return {
        eyebrow: "Notifications", title: native ? "Turn on notifications." : "Get notified, and add it to your home screen.",
        body: <>
          <p>{native ? "Get a notification for new messages, news, and reminders." : "On a phone, add Family Village to your home screen so it opens like an app and can send you notifications."}</p>
          <PushSection />
        </>,
      };
    case "secure":
      return {
        eyebrow: "Sign in faster", title: "Add a passkey.",
        body: <>
          <p>A passkey lets you sign in with Face ID, a fingerprint, or your phone&rsquo;s passcode instead of typing a password. You can add one any time under Account &amp; security.</p>
          <button type="button" className="ghost" onClick={openAccount}>Open Account &amp; security</button>
        </>,
      };
    case "teacher":
      return {
        eyebrow: "For teachers", title: "Your classes, your channel.",
        body: <p>The Teacher&rsquo;s Lounge shows only your classes. Add notes, handouts, and photos there. In Messages, choose <b>New</b>, then <b>Class channel</b> to talk with a whole class at once. A photo submitted by a parent waits for your approval.</p>,
      };
    case "admin":
      return {
        eyebrow: "For administrators", title: "Running the village.",
        body: <p>Invite families, and resend or delete invitations, under <b>Invitations</b>. Reported messages and photos appear under <b>Reports</b>. You can&rsquo;t browse private messages, only reported ones. When someone asks to delete their account, you can do it from <b>Families</b>.</p>,
      };
    case "done":
      return {
        eyebrow: "All set", title: "You’re ready.",
        body: <p>You can open this tour again any time from your account menu, under <b>Take the tour</b>.</p>,
      };
  }
}

export default function OnboardingTour({ roles, returning, onFinish, onOpenAccount }: {
  roles: string[]; returning: boolean; onFinish: () => void; onOpenAccount: () => void;
}) {
  const steps = tourSteps({ roles, returning });
  const [index, setIndex] = useState(0);
  // Inside the iPhone or Android app the early platform script marks the page as native (lib/platform.ts); in a browser it does not.
  const native = typeof document !== "undefined" && document.documentElement.dataset.shell === "native";
  const last = index === steps.length - 1;
  const copy = stepCopy(steps[index], returning, native, () => { onFinish(); onOpenAccount(); });

  return <DetailModal title={returning ? "What's new" : "Getting started"} onClose={onFinish}>
    <div className="tour">
      <p className="eyebrow">{copy.eyebrow}</p>
      <h2>{copy.title}</h2>
      <div className="tour-body">{copy.body}</div>
      <ol className="tour-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
        {steps.map((id, i) => <li key={id} className={i === index ? "active" : i < index ? "seen" : ""} />)}
      </ol>
      <div className="row-actions tour-actions">
        {index > 0 && <button type="button" className="ghost" onClick={() => setIndex(index - 1)}>Back</button>}
        <button type="button" onClick={() => (last ? onFinish() : setIndex(index + 1))}>{last ? "Done" : "Next"}</button>
        {!last && <button type="button" className="ghost tour-skip" onClick={onFinish}>Skip for now</button>}
      </div>
    </div>
  </DetailModal>;
}
