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
  metadataBase: new URL("https://getalldocs.com"),
  title: "AllDocs · Universal Document Editor",
  description:
    "Free, no-signup universal document editor and converter. Drop a PDF, DOCX, XLSX, PPTX, Markdown, HTML, EPUB, or image — view it, edit it, export it back.",
};

// Inline script: read the stored theme and stamp data-theme onto <html>
// BEFORE React hydrates. Dark is the unconditional default — AllDocs
// is dark-first by design; light is opt-in. We do NOT consult
// prefers-color-scheme; a user whose system is light still gets dark
// here until they pick light explicitly.
const themeBootstrap = `
(function(){try{
  var v = localStorage.getItem('alldocs-theme');
  if (v !== 'light' && v !== 'dark') v = 'dark';
  document.documentElement.setAttribute('data-theme', v);
}catch(e){}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the themeBootstrap script below stamps
    // data-theme onto <html> BEFORE React hydrates, which by design
    // makes the client-rendered DOM differ from the server HTML on
    // this single attribute. Standard pattern; the warning is noise.
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
