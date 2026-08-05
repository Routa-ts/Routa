export const packageManagers = ["npm", "pnpm", "yarn", "bun"] as const;

export type PackageManager = (typeof packageManagers)[number];

export const createCommandsByPackageManager = {
	npm: "npm create routa-ts@latest",
	pnpm: "pnpm create routa-ts@latest",
	yarn: "yarn create routa-ts",
	bun: "bun create routa-ts@latest",
} as const satisfies Record<PackageManager, string>;
