import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AllDocs",
  description:
    "Universal document editor and converter — read, edit, and export every document format through a single Universal Document Model.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
