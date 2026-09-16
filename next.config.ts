import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This project already has its own docs (README, ARCHITECTURE.md,
  // DESIGN_DECISIONS.md, BENCHMARKS.md) -- no need for Next's auto-generated
  // AGENTS.md/CLAUDE.md.
  agentRules: false,
};

export default nextConfig;
