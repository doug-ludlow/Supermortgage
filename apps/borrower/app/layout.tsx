import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
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
  themeColor: "#0A0A0B",
};

/** Dark is the default (00 §3, 01 §2); light is a second token set selected by data-theme only. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={THEME_DEFAULT}>
      <body>{children}</body>
    </html>
  );
}
