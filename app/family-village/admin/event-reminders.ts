/** One row of public.admin_upcoming_event_reminders: a reminder that is planned, went out, or was skipped. */
export type ReminderRow = {
  event_id: string; event_title: string; class_title: string | null; event_date: string; offset_days: number;
  send_at: string; send_label: string; recipients: number; status: "scheduled" | "sent" | "skipped" | "not_sent";
};

export const when = (days: number) => (days === 0 ? "The day of" : `${days} day${days === 1 ? "" : "s"} before`);

/** One line in plain words: "3 days before: Mon, Dec 7 at 9:00 AM (Central), 41 people". */
export function reminderLine(row: ReminderRow): string {
  const people = `${row.recipients} ${row.recipients === 1 ? "person" : "people"}`;
  switch (row.status) {
    case "sent": return `${when(row.offset_days)}: sent ${row.send_label}, to ${people}`;
    case "scheduled": return `${when(row.offset_days)}: goes out ${row.send_label}, to ${people}`;
    case "skipped": return `${when(row.offset_days)}: skipped, the event was added or changed after that time`;
    default: return `${when(row.offset_days)}: not sent`;
  }
}
