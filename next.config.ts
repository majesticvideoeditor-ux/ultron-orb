import type { NextConfig } from "next";

const repoName = "/ultron-orb";

const nextConfig: NextConfig = {
  output: "export",
  basePath: repoName,
  assetPrefix: `${repoName}/`,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
