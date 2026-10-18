import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MoneyTrail — spending & refunds",
  description: "Track spending, refunds, subscriptions, and upcoming bills.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
