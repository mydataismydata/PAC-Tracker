import type { NextConfig } from 'next';
import pkg from './package.json';
import stamp from './build-number.json';

const nextConfig: NextConfig = {
  // Baked in at build time for src/lib/version.ts. The Docker build context
  // leaves out .git, so the build number has to come from a tracked file.
  env: {
    APP_VERSION: pkg.version,
    APP_BUILD: String(stamp.build),
  },
  // Emits .next/standalone with only the traced runtime dependencies, so the
  // Docker image ships a ~200MB server instead of the full node_modules tree.
  output: 'standalone',
  // pnpm's symlinked store confuses dependency tracing unless the root is
  // pinned explicitly; without this the standalone build drops packages.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
