import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./mobile-shell.css";
import "./prototype-theme.css";
import { THEME_DEFAULT } from "@/lib/env";

export const metadata: Metadata = {
  title: "Supermortgage",
  description: "Your loan, in one conversation.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f4f4",
};

/** Designed prototype surface is the default. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={THEME_DEFAULT}>
      <body>{children}</body>
    </html>
  );
}
