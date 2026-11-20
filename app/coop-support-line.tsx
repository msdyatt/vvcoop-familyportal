"use client";

import { useCoopTheme } from "../lib/coop-settings";

/** "Need help? …" with the co-op's support contact (Admin, Appearance). Nothing when none is set. */
export default function CoopSupportLine() {
  const { supportEmail, supportPhone } = useCoopTheme();
  if (!supportEmail && !supportPhone) return null;
  return <p className="coop-support-line">
    Need help? {supportEmail && <a href={`mailto:${supportEmail}`}>{supportEmail}</a>}
    {supportEmail && supportPhone && " or "}
    {supportPhone && <a href={`tel:${supportPhone.replace(/[^0-9+]/g, "")}`}>{supportPhone}</a>}
  </p>;
}
