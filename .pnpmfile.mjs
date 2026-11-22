/**
 * Core and the CLI bundle the private `@routa-ts/contract-rules` package into their output, so
 * their published manifests leave it out. `scripts/pack-check.mjs` checks that no tarball names it.
 */
export const hooks = {
	beforePacking(manifest) {
		delete manifest.devDependencies?.["@routa-ts/contract-rules"];
		return manifest;
	},
};
