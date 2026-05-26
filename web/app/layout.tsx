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

// Inline script: read the stored / preferred theme and stamp data-theme
// onto <html> BEFORE React hydrates. Without this the page would flash
// dark and then switch to light (or vice-versa) on first paint.
const themeBootstrap = `
(function(){try{
  var v = localStorage.getItem('alldocs-theme');
  if (v !== 'light' && v !== 'dark') {
    v = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', v);
}catch(e){}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
