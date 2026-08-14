import { defineConfig } from 'vitest/config'

// Nothing here measured or bounded an untested branch. For a package whose
// masking logic is the sole redaction control across two CI systems — and whose
// output four implementations must agree on — an untested branch is the shape
// every gap in this suite has taken so far: the fail-open path, the asymmetric
// key path, the prototype-chain read.
//
// The thresholds sit just under the current numbers, so they catch a regression
// rather than merely describing today. Branch coverage is the one that matters
// most here: isSens and the attrs loop are almost entirely branches.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 92,
        branches: 93,
        functions: 100,
        lines: 95,
      },
    },
  },
})
