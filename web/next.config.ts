import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A stray package-lock.json one directory above can confuse Next's
  // workspace-root auto-detection (see web/package.json comments).
  // Pin the tracing root to the repo root explicitly.
  outputFileTracingRoot: resolve(here, ".."),
};

export default nextConfig;
