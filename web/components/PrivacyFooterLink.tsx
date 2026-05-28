"use client";

import { useState } from "react";

import { PrivacyModal } from "./PrivacyModal";

/** Footer entry point to the privacy + telemetry settings. Kept in
 * its own client component so the static page.tsx layout stays a
 * server component. */
export function PrivacyFooterLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hover:text-fg transition-colors"
      >
        privacy
      </button>
      <PrivacyModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
