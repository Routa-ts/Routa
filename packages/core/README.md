# @routa-ts/core

Core framework APIs for Routa, a schema-first, OpenAPI-aware REST framework for new TypeScript APIs.

Routa route contracts keep HTTP behavior explicit in source: inputs, responses, middleware, metadata, and handler boundaries live together. The core package provides the route definition helpers and runtime primitives used by Routa applications and generated code.

## Install

```sh
pnpm add @routa-ts/core@0.1.2 hono@^4.12.27 zod@^4.4.3
```

## Usage

```ts
import { createRoute, defineRoute } from "@routa-ts/core";
import { z } from "zod";

export default defineRoute({
	get: createRoute({
		responses: {
			success: {
				status: 200,
				schema: z.object({ ok: z.boolean() }),
			},
		},
		run: async () => {
			return { type: "success", data: { ok: true } };
		},
	}),
});
```

## Packages

- `@routa-ts/core`: framework APIs
- `@routa-ts/cli`: `routa` command for checks, builds, scaffolding, and dev server
- `create-routa-ts`: project scaffolder for `pnpm create routa-ts`

## Links

- Repository: https://github.com/Routa-ts/Routa
- Documentation: https://routa-ts.dev
