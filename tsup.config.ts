import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: ['node18', 'chrome100'],
  platform: 'neutral',
  treeshake: true,
  minify: false,
  outExtension({ format }) {
    if (format === 'esm') {
      return { js: '.mjs' };
    }
    if (format === 'cjs') {
      return { js: '.cjs' };
    }
    return { js: '.js' };
  },
});
