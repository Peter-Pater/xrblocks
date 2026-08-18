import {defineConfig} from 'vitest/config';
import {resolve} from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'xrblocks/addons': resolve(__dirname, './src/addons'),
      xrblocks: resolve(__dirname, './src/xrblocks.ts'),
      // Browser-CDN-only (see rollup.config.js externalPackages) and not an
      // npm dependency of this repo; stubbed so tests that transitively
      // import Object3DDetector.ts (which reaches it via a dynamic import()
      // inside SamMask.ts, never called from a unit test) still resolve
      // under Vite's static import analysis.
      '@huggingface/transformers': resolve(
        __dirname,
        './src/testStubs/huggingfaceTransformersStub.ts'
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/samples/**'],
      reporter: ['text-summary', 'html'],
    },
  },
});
