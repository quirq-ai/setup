import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Set up qq",
  description: "Pick the GitHub org and repos qq-setup should set up.",
  icons: { icon: "/brand/quirq/app-icon.svg" },
  robots: { index: false, follow: false },
};

// Served only by qq-setup on 127.0.0.1. No web fonts: the page loads nothing from the internet.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-8">
          {/* White artwork from innernet public/brand/quirq; light theme recolors it in CSS. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/quirq/wordmark.svg" alt="quirq" width={307} height={159} className="brand-wordmark" />
          <span className="font-display text-lg">Set up qq</span>
        </header>
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </body>
    </html>
  );
}
