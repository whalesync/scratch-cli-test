import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

const sharedTypesSrc = resolve('../packages/shared-types/src/index.ts');
// The `@spinner/shared-types/transform` subpath (display transformer applier +
// its jsonpath-rfc9535 dep) is intentionally NOT in the barrel, so it needs its
// own source alias. Must be registered BEFORE the barrel alias so the more
// specific `/transform` import matches first.
const sharedTypesTransformSrc = resolve('../packages/shared-types/src/transform/index.ts');
// The `@spinner/shared-types/format` subpath (canonical record-JSON serializer)
// is its own lean module so the main process can import it without bundling the
// rest of the barrel. Like `/transform`, register it BEFORE the barrel alias.
const sharedTypesFormatSrc = resolve('../packages/shared-types/src/format/index.ts');
// The `@spinner/shared-types/api-client` subpath (the shared REST client + its axios dep) is
// intentionally NOT in the barrel so the server never bundles axios. Like `/transform` and
// `/format`, register it BEFORE the barrel alias so the more specific import matches first.
const sharedTypesApiClientSrc = resolve('../packages/shared-types/src/api-client/index.ts');

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // Same as renderer: bundle from source so main never requires node_modules/@spinner/shared-types/dist.
        '@spinner/shared-types/transform': sharedTypesTransformSrc,
        '@spinner/shared-types/format': sharedTypesFormatSrc,
        '@spinner/shared-types/api-client': sharedTypesApiClientSrc,
        '@spinner/shared-types': sharedTypesSrc,
      },
    },
    plugins: [
      externalizeDepsPlugin({
        // @spinner/shared-types is aliased to monorepo source above; if externalized, main would still require() the npm package.
        // lodash: shared-types (e.g. ids.ts) uses lodash/findKey; electron-builder strips node_modules/lodash from app.asar (renderer-only), so bundle it into main.
        exclude: ['electron-store', '@spinner/shared-types', 'lodash'],
      }),
    ],
    build: {
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@spinner/shared-types/transform': sharedTypesTransformSrc,
        '@spinner/shared-types/format': sharedTypesFormatSrc,
        '@spinner/shared-types/api-client': sharedTypesApiClientSrc,
        '@spinner/shared-types': sharedTypesSrc,
      },
    },
    plugins: [react()],
    build: {
      commonjsOptions: {
        include: [/node_modules/],
      },
    },
    css: {
      modules: {
        localsConvention: 'camelCaseOnly',
      },
    },
  },
});
