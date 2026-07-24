import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle for a slim production container image (SPEC-18).
  output: "standalone",
};

export default nextConfig;
