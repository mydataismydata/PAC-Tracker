import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits .next/standalone with only the traced runtime dependencies, so the
  // Docker image ships a ~200MB server instead of the full node_modules tree.
  output: 'standalone',
  // pnpm's symlinked store confuses dependency tracing unless the root is
  // pinned explicitly; without this the standalone build drops packages.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
