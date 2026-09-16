import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodePulse",
  description: "Release debugging: commits, PRs, CI, deployments, and service health in one timeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header
          style={{
            borderBottom: "1px solid var(--border)",
            padding: "12px 20px",
            display: "flex",
            gap: 20,
            alignItems: "baseline",
          }}
        >
          <Link href="/" style={{ fontWeight: 700, color: "var(--text)" }}>
            CodePulse
          </Link>
          <span style={{ color: "var(--text-dim)" }}>release debugging platform</span>
        </header>
        <main style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
