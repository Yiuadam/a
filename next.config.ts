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
  : {
      /*
        Cross-origin isolation, for the speaking test only.

        On-device transcription runs whisper.cpp in WebAssembly, which is built
        with threads, and a browser only hands out SharedArrayBuffer to a
        cross-origin-isolated document. These two headers are what buy that.
        They are scoped to /speaking rather than applied site-wide because
        isolation constrains every cross-origin subresource a page loads, and
        only this page needs it. The model download still works: it is a CORS
        request, which satisfies require-corp.

        A static export has no server to send headers, so the iOS bundle never
        becomes isolated — which is why iOS transcribes through the native
        whisper plugin instead of the WASM one.
      */
      async headers() {
        return [
          {
            source: "/speaking/:path*",
            headers: [
              { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
              { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
            ],
          },
        ];
      },
    };

export default nextConfig;
