/**
 * Test-only stand-in for `@huggingface/transformers`.
 *
 * The real package is loaded from a CDN via the browser importmap (see
 * `demos/objects_3d/index.html`) and is intentionally not an npm dependency
 * of this repo — `rollup.config.js` lists it under `externalPackages` for
 * exactly that reason. `SamMask.ts` only reaches it through a dynamic
 * `import()` inside `getSam()`, which no unit test calls, but Vite's static
 * import analysis still needs the specifier to resolve when a test
 * transitively imports `Object3DDetector.ts`. This empty stub, aliased in
 * `vitest.config.ts`, satisfies that without adding a real (large, ML)
 * dependency just for type/module resolution.
 */
export {};
