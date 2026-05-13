import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--app-font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--app-font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AllDocs · Universal Document Editor",
  description:
    "Free, no-signup universal document editor and converter. Drop a PDF or DOCX, view it, edit it, export it. Open source under AGPL-3.0.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
