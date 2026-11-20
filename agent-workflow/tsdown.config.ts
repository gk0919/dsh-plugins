import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const { name } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig([
  {
    entry: ['src/**/*.ts', 'test/**/*.ts'],
    root: '.',
    unbundle: true,
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: false,
    deps: { neverBundle: true },
    dts: false,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { client: 'client/index.js' },
    outDir: 'dist',
    format: 'cjs',
    platform: 'browser',
    inputOptions: { platform: 'browser' },
    target: 'es2023',
    outExtensions: () => ({ js: '.js' }),
    deps: { neverBundle: ['react'] },
    dts: false,
    clean: false,
    // DSH loads a factory and supplies its own React instance.
    banner: `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:require=>{const module={exports:{}};const exports=module.exports;`,
    footer: 'return module.exports}});',
  },
])
