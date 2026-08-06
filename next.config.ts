import type { NextConfig } from "next";

/*
  Two build targets from one codebase:

  - Default (`npm run build`): a normal Next.js app deployed to Vercel. The
    /api routes run there and hold the Anthropic API key.
  - Mobile (`npm run build:mobile`): a fully static export bundled inside the
    iOS app by Capacitor. The static build has no server, so it calls the
    deployed /api routes over the network via NEXT_PUBLIC_API_BASE.
*/
const isMobile = process.env.MOBILE_BUILD === "1";

const nextConfig: NextConfig = isMobile
  ? {
      output: "export",
      distDir: "out-mobile",
      images: { unoptimized: true },
      // Static hosting inside a WebView serves index.html per directory.
      trailingSlash: true,
    }
  : {};

export default nextConfig;
