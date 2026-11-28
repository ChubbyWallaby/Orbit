import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // `npm run verify` builds a second copy (with a fake analytics key) next to the normal one
  ...(process.env.ORBIT_DIST_DIR ? { distDir: process.env.ORBIT_DIST_DIR } : {}),
};

export default nextConfig;
