import type { NextConfig } from "next";

// The form is a static page that the qq-setup command serves on 127.0.0.1 (cli/server.mjs).
// It has no server of its own: every answer goes to the command through /api/*.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
  // out/ is committed (npx runs the package as downloaded and must not build), so the same source must give the same bytes.
  generateBuildId: async () => "qq-setup",
};

export default nextConfig;
