import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        dts: true,
        target: 'es2022',
        outDir: 'dist',
        splitting: true,
        clean: true,
    },
    {
        entry: ['src/cli.ts'],
        format: ['cjs'],
        dts: false,
        target: 'es2022',
        outDir: 'dist',
        splitting: false,
        clean: false,
        banner: {
            js: '#!/usr/bin/env node',
        },
    },
]);
