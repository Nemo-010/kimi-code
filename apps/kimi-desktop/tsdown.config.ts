import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/main/index.ts', 'preload/index': 'src/preload/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'out',
  clean: true,
  dts: false,
  fixedExtension: true,
  deps: { neverBundle: ['electron'] },
});
