import type { NextConfig } from "next";

/*
  Two build targets from one codebase:

  - Default (`npm run build`): a normal Next.js app, deployed to Cloudflare
    Workers via the OpenNext adapter. The /api routes run there and hold the
    Anthropic API key.
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
          /*
            Never reuse a page without asking whether it is still the current
            one.

            This is not a performance preference, it is a correctness fix, and
            the failure it prevents is total. Next fingerprints the stylesheet,
            so every deploy that changes a single class writes a new
            `/_next/static/chunks/<hash>.css` and *deletes the old one*.
            Meanwhile a prerendered page was going out with
            `Cache-Control: s-maxage=31536000` and nothing addressed to the
            browser at all — a year to any shared cache, and heuristic
            freshness everywhere else.

            Put those together and a cached page outlives the stylesheet it
            names. The browser asks for a hash that no longer exists, gets a
            404, and renders the whole app as unstyled HTML: no layout, no
            colours, icons drawn at the width of the page. It looks like a
            broken deployment and the deployment is fine.

            `max-age=0, must-revalidate` keeps the copy and revalidates it, so
            a page that has not changed still costs a 304 and not a download.
            The exclusion below is the part that must not be got wrong:
            /_next/static is content-addressed and immutable, so it keeps its
            own far-future caching. Only documents lose theirs.
          */
          {
            source: "/((?!_next/static|_next/image).*)",
            headers: [
              { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
            ],
          },
        ];
      },
    };

export default nextConfig;
