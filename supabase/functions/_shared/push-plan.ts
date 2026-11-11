/**
 * Whether deliver-push should send a notification to a person, and if not, why. The rules
 * come from public.channel_access_for (inactive profiles and reviewer accounts are never
 * contacted; push switched off is respected; quiet mode holds back everything but urgent).
 */
export type Access = { user_id: string; active: boolean; push_ok: boolean; has_device: boolean; quiet: boolean };
export type PushDecision = { send: true } | { send: false; reason: "inactive" | "no_device" | "push_disabled" | "quiet_mode" };

export function decidePush(access: Access | undefined, kind: string): PushDecision {
  if (!access || !access.active) return { send: false, reason: "inactive" };
  if (access.quiet && kind !== "broadcast_urgent") return { send: false, reason: "quiet_mode" };
  if (!access.has_device) return { send: false, reason: "no_device" };
  if (!access.push_ok) return { send: false, reason: "push_disabled" };
  return { send: true };
}
