import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
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

/** 32.19: globals.css keeps the non-/app routes (account, deep-link, return, disclosures, document pages); the Apply product's tokens are apply.css's. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme={THEME_DEFAULT}>
      <body>{children}</body>
    </html>
  );
}
