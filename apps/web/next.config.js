const { withPlausibleProxy } = require("next-plausible");

// Suppress specific external package warnings
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  const message = args.join(" ");
  if (
    message.includes("Package mongodb can't be external") ||
    message.includes("Package pg can't be external") ||
    message.includes("Package sqlite3 can't be external") ||
    message.includes("Package typeorm can't be external") ||
    message.includes("matches serverExternalPackages") ||
    message.includes("Try to install it into the project directory")
  ) {
    return; // Suppress these warnings
  }
  originalConsoleWarn.apply(console, args);
};

/** @type {import('next').NextConfig} */
// The Plausible analytics proxy is only enabled when configured; this keeps
// self-hosted deployments from loading third-party scripts from plausible.io.
const nextConfig = {
  reactStrictMode: false,
  transpilePackages: [
    "prettier",
    "shiki",
    "@dub/email",
    "@boxyhq/saml-jackson",
  ],
  outputFileTracingIncludes: {
    "/api/auth/saml/token": [
      "./node_modules/jose/**/*",
      "./node_modules/openid-client/**/*",
    ],
  },
  experimental: {
    optimizePackageImports: [
      "@dub/email",
      "@dub/ui",
      // Disabled: causes "Module not found: chunk-WKSJXYEU.mjs" on Vercel due to tsup's chunked output
      // "@dub/utils",
      "@team-plain/typescript-sdk",
    ],
    serverActions: {
      bodySizeLimit: "4mb",
    },
    // low-memory-friendly builds (self-hosted servers / small CI runners)
    webpackMemoryOptimizations: true,
    cpus: Math.max(1, Math.min(4, Number(process.env.BUILD_CPUS) || 2)),
  },
  webpack: (config, { webpack, isServer }) => {
    if (isServer) {
      config.plugins.push(
        // mute errors for unused typeorm deps
        new webpack.IgnorePlugin({
          resourceRegExp:
            /(^@google-cloud\/spanner|^@mongodb-js\/zstd|^aws-crt|^aws4$|^pg-native$|^mongodb-client-encryption$|^@sap\/hana-client$|^@sap\/hana-client\/extension\/Stream$|^snappy$|^react-native-sqlite-storage$|^bson-ext$|^cardinal$|^kerberos$|^hdb-pool$|^sql.js$|^sqlite3$|^better-sqlite3$|^ioredis$|^typeorm-aurora-data-api-driver$|^pg-query-stream$|^oracledb$|^mysql$|^snappy\/package\.json$|^cloudflare:sockets$)/,
        }),
      );
    }

    config.module = {
      ...config.module,
      exprContextCritical: false,
    };

    return config;
  },
  images: {
    remotePatterns: [
      {
        hostname: "assets.dub.co", // for Dub's static assets
      },
      {
        hostname: "dubassets.com", // for Dub's user generated images
      },
      {
        hostname: "dev.dubassets.com", // dev bucket
      },
      {
        hostname: "www.google.com",
      },
      {
        hostname: "avatar.vercel.sh",
      },
      {
        hostname: "faisalman.github.io",
      },
      {
        hostname: "api.dicebear.com",
      },
      {
        hostname: "pbs.twimg.com",
      },
      {
        hostname: "lh3.googleusercontent.com",
      },
      {
        hostname: "avatars.githubusercontent.com",
      },
      {
        hostname: "media.cleanshot.cloud", // only for staging purposes
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Referrer-Policy",
            value: "no-referrer-when-downgrade",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
        ],
      },
      {
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *",
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/api/:path*",
        missing: [
          {
            type: "host",
            // dub.co hosts, localhost, and single-label container hostnames
            // (e.g. the docker-network service name "web") all serve the API
            value: ".*(\\.dub\\.co|localhost|^[^.]+$)",
          },
        ],
        destination: "/",
        permanent: false,
      },
      {
        source: "/",
        has: [
          {
            type: "host",
            value: "app.dub.sh",
          },
        ],
        destination: "https://app.dub.co",
        permanent: true,
        statusCode: 301,
      },
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "app.dub.sh",
          },
        ],
        destination: "https://app.dub.co/:path*",
        permanent: true,
        statusCode: 301,
      },
    ];
  },
  async rewrites() {
    return [
      // for dub proxy
      {
        source: "/_proxy/dub/script.js",
        destination: "https://www.dubcdn.com/analytics/script.js",
      },
      {
        source: "/_proxy/dub/track/:path*",
        destination: "https://api.dub.co/track/:path*",
      },
    ];
  },
  // Standalone server output for Docker deployments
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
};

module.exports = process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL
  ? withPlausibleProxy({
      src: process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL,
      scriptPath: "/_proxy/plausible/script.js",
      apiPath: "/_proxy/plausible/event",
    })(nextConfig)
  : nextConfig;
