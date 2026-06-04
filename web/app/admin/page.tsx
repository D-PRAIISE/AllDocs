import type { Metadata } from "next";

import { AdminClient } from "@/components/AdminClient";

export const metadata: Metadata = {
  title: "AllDocs · Admin",
  // Never index the admin surface.
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <main className="min-h-screen">
      <AdminClient />
    </main>
  );
}
