"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, getPushState, isIosDevice, sendTestPush, type PushState } from "../../lib/push";

type InstallPrompt = Event & { prompt: () => Promise<void> };

/**
 * Push notifications for this device, plus the install-to-home-screen step
 * that makes them possible on iPhone and easier everywhere else.
 */
export default function PushSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    getPushState().then(setState);
    const capture = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener("beforeinstallprompt", capture);
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);

  async function turnOn() {
    setBusy(true); setMessage("");
    const result = await enablePush();
    if (!result.ok) setMessage(result.error);
    setState(await getPushState());
    setBusy(false);
  }

  async function turnOff() {
    setBusy(true); setMessage("");
    await disablePush();
    setState(await getPushState());
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    setMessage(await sendTestPush());
    setBusy(false);
  }

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  }

  if (!state) return null;

  return <div className="settings-block">
    <p className="card-kicker">Phone &amp; notifications</p>
    <p className="portal-empty">Get a notification on this device for news, class notes, and reminders, and open the portal like an app.</p>

    {installPrompt && <button type="button" className="ghost" onClick={install}>Add Veritas Village to this device</button>}

    {state === "needs-install" && <ol className="field-note">
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</li>
      <li>Open <b>Veritas Village</b> from your Home Screen and come back here to turn notifications on.</li>
    </ol>}
    {state === "unsupported" && <p className="field-note">This browser can&rsquo;t show notifications{isIosDevice() ? "" : ". Try Chrome, Edge, Firefox, or Safari"}.</p>}
    {state === "denied" && <p className="field-note">Notifications are blocked for this site. Allow them in your browser or phone settings, then come back and turn them on.</p>}

    {state === "off" && <button type="button" disabled={busy} onClick={turnOn}>{busy ? "Working…" : "Turn on notifications"}</button>}
    {state === "on" && <div className="print-queue-actions">
      <button type="button" className="ghost" disabled={busy} onClick={test}>Send a test</button>
      <button type="button" className="ghost" disabled={busy} onClick={turnOff}>Turn off on this device</button>
    </div>}
    {state === "on" && <p className="field-note">Notifications are on for this device. Each phone or computer is set up separately.</p>}
    <p className="admin-form-status" role="status">{message}</p>
  </div>;
}
