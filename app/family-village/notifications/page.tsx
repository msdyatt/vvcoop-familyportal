import NotificationsApp from "./notifications-app";

export const metadata = { title: "Notifications | Family Village" };

/** The notification list as its own page. The iPhone app's bell opens it as a sheet; the web uses the bell's dropdown instead. */
export default function NotificationsPage() { return <NotificationsApp />; }
