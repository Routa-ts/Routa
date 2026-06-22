# Trail HTTP Contract Design - Group 1 Wrap-Up

## Purpose

This file consolidates the final decisions that close Group 1 of the REST backend framework review.

---

## HTTP contract philosophy and framework boundary

### Content types (v1 scope)

- Trail v1 supports modern and commonly used content types.
- Trail v1 does not target obscure or niche enterprise-only content types.

### Practical HTTP interoperability

- Trail follows practical HTTP interoperability rather than supporting rarely used edge-case method and body combinations by default.

### Framework boundary

- Trail is strict about HTTP semantics at the route contract layer.
- Trail remains non-opinionated about service implementation details.
- Trail enforces transport contracts, input and output shapes, and route semantics.
- Trail does not attempt to prove or police internal service side effects.

---

## Response Authoring Levels

Trail supports three levels of response authoring complexity.

**Route files:** The snippets below use a single **`createRoute`** for clarity. In a real **resource route file**, each level is nested under **`defineRoute`**: flat **`get` / `post`** keys on the **collection** file, and **`params` + `methods`** on **dynamic** segments (`users/$id/`)—see **Routing** in `backend_framework_design.md`.

### Level 1: Simple

The user defines only a success schema.

```ts
createRoute({
	response: UserSchema,

	run: async () => {
		return {
			type: "success",
			data: user,
		};
	},
});
```

In the simple form, top-level **`response`** on `createRoute` is only the **success schema declaration**. **`run`** returns **`{ type, data }`**, not `response`, for the payload (see **Runtime return shape**).

Behavior:

- Trail infers the success status from the HTTP method.
- Default response content type is `application/json`.
- Trail internally expands this into the normalized response model.

Default success status by method:

- `GET` -> `200`
- `POST` -> `201`
- `PUT` -> `200`
- `PATCH` -> `200`
- `DELETE` -> `200` if a success schema exists

Special case for `DELETE`:

- `DELETE` is the only method where the success response body is optional.
- If `DELETE` has no success schema, Trail defaults to `204 No Content`.
- If `DELETE` has a success schema, Trail defaults to `200 OK`.

All other methods must define a success response shape through the simple or expanded response forms.

### Level 2: Professional

The user defines explicit response variants.

```ts
createRoute({
	responses: {
		success: {
			status: 200,
			schema: UserSchema,
		},
		notFound: {
			status: 404,
			schema: NotFoundSchema,
		},
		emailConflict: {
			status: 409,
			schema: EmailConflictSchema,
		},
	},

	run: async () => {
		return {
			type: "emailConflict",
			data: {
				message: "Email already exists",
			},
		};
	},
});
```

Rules:

- Response key becomes the runtime discriminant `type`.
- `type` resolves to status, schema, and HTTP representation.
- Users may use Trail's built-in `problem(...)` helper for problem-details-based errors.
- Users may also provide plain schemas instead of using the helper.

Recommended shorthand:

```ts
createRoute({
	responses: {
		success: [200, UserSchema],
		notFound: [404, NotFoundSchema],
	},
});
```

### Level 3: Advanced

The user can express richer OpenAPI-compatible schemas through helpers without writing raw OpenAPI objects.

Non-JSON adapters such as **`csv()`** take a callback whose parameter type is the **inferred validated canonical type** for that response variant—whatever the **`schema`** expression implies when it uses helpers like **`anyOf`**, **`allOf`**, or **`nullable`**. You implement how that value maps to wire-format text (narrowing, branching, or normalizing as needed). Trail validates against the composed schema first; the serializer then receives a value that satisfies it.

```ts
const UserWithMetadataSchema = allOf([UserSchema, MetadataSchema]);
type SuccessPayload = z.infer<typeof UserWithMetadataSchema>;

createRoute({
	responses: {
		success: {
			status: 200,
			schema: UserWithMetadataSchema,
			content: {
				"application/json": json(),
				"text/csv": csv((row: SuccessPayload) =>
					[
						"id,name,email,updatedAt",
						`${row.id},${row.name},${row.email},${row.updatedAt}`,
					].join(
						"\n",
					),
				),
			},
		},
		error: {
			status: 400,
			schema: allOf([BaseErrorSchema, ExtendedErrorSchema]),
		},
	},
});
```

Helper direction:

- `anyOf([...])`
- `allOf([...])`
- `nullable(schema)`
- `arrayOf(schema)`
- `paginated(schema)`

---

## Normalized Internal Response Model

All three authoring levels normalize into one internal model.

```ts
type NormalizedResponse = {
	status: number;
	schema?: Schema;
	content: Record<string, RepresentationAdapter>;
	headers?: HeaderSpec;
	cookies?: CookieSpec;
};
```

This normalized model is the source of truth for:

- runtime response mapping
- output validation
- serialization
- OpenAPI generation

---

## Runtime Return Shape

Route handlers return declared variants using the **`{ type, data }`** shape derived from `responses`. Application code may also return this shape when the developer chooses that pattern.

```ts
type RouteResponse =
	| {
			type: "success";
			data: User;
	  }
	| {
			type: "notFound";
			data: NotFoundError;
	  };
```

Rules:

- The discriminant `type` is generated from the response key.
- **`data`** is the **body payload** only. Payload schemas on the route do not include that discriminant; Trail wires `type` and `data` together internally.
- For error variants modeled as **problem details**, **`data`** carries the public problem fields (**`title`**, **`detail`**, **`instance`**, optional RFC **`type`** (problem-type URI, distinct from the union discriminant **`type`**), **`code`**, plus any extension properties). **`data` must not include HTTP `status`**: the status line comes from the **`responses`** entry for that variant, so application code does not need to carry HTTP status in payload data.
- Application code may **import and return** the generated **`{ type, data }`** union for the route, or return **domain-only** results and let **`run`** map into that union; both are supported (see the consolidated example later). Trail does not generate or own that application code.

---

## Route outcomes, declarations, and application boundary

### Success responses

- In the simple route form, Trail infers default success status codes; the route can define only a success schema and rely on Trail defaults.
- In the professional and advanced route forms, explicit success status declarations are enforced where those forms apply.

### Error responses

- Non-2xx responses should be declared when the route or middleware intends to produce them directly.
- Global unhandled errors do not need to be declared per route.
- Validation errors do not need to be declared per route.
- Validation errors are documented automatically anywhere an input schema exists.

### Input and output schema rules

- A route may omit input schemas entirely.
- A route must still define at least one success output schema.

### Application boundary

- Application code may return **only domain data** and rely on **`run`** to produce the route’s `{ type, data }` union, or it may **import the framework-generated response type** for that route and return that union directly so types stay tied to the declared `responses`.
- Either way, **Trail** maps the value **`run`** returns to the HTTP response (status, headers, negotiated body).

### Escape hatch

- Trail supports raw platform responses through an explicit escape hatch.
- The escape hatch is intended for cases like streaming, file responses, redirects, or unusual transport behavior.

---

## Response Builder

Trail's response builder is variant-driven.

Runtime flow:

1. Receive returned `{ type, data }`.
2. Resolve the declared response variant.
3. Validate the returned `data` against the declared schema in development.
4. In production, output validation is configurable.
5. Negotiate response content type from the `Accept` header.
6. Serialize the selected representation from the validated **`data`** payload.
7. Write status (from the declared variant), headers, cookies, and body.

Notes:

- `204` responses skip body serialization.
- Binary/file responses use response descriptors.
- Same-status response variants stay separate at runtime even if OpenAPI merges them.

---

## Request Parser

Trail's request parsing is route-driven and strict.

Parsing flow:

1. Inspect method.
2. Inspect `Content-Type`.
3. Select an approved built-in parser if the route supports it.
4. Reject unsupported request media types with `415 Unsupported Media Type`.
5. Parse the raw transport format.
6. Pass parsed values into the declared schemas.

Boundary:

- Trail parses transport formats.
- The schema library owns coercion and scalar conversion.

---

## Approved Built-In V1 Content Types

Trail v1 supports only a built-in approved set of content types. Custom user-defined content types are deferred to a later version.

### Request Input

- `application/json`
- `multipart/form-data`
- `application/x-www-form-urlencoded`
- `text/plain`

### Response Output

- `application/json`
- `application/problem+json`
- `text/plain`
- `text/csv`
- `application/octet-stream`
- explicit file types such as `application/pdf`, `image/png`, `image/jpeg`

Not included by default in v1:

- XML
- vendor-specific custom media types
- niche enterprise-only formats

---

## Response Representations and Content Negotiation

### Default Behavior

- Trail defaults to `application/json` for normal route responses.
- A single declared response variant may support multiple content types.
- Trail selects the response representation from the request `Accept` header.
- Trail does not use query parameters for representation negotiation.
- Application code does not choose the wire representation in the normal path.

### Canonical Response Schema

- Each response variant has one canonical payload schema.
- All declared content types for that response variant are representations of the same canonical payload.
- Route handlers return that canonical payload shape through the generated `{ type, data }` union. Application services may return that shape if the developer chooses, but Trail does not require or generate services.
- Trail validates the canonical payload first, then serializes it to the selected content type.
- Different content types on the same response variant should not require different application payload shapes in the normal path.

### Structured Non-JSON Responses

- Structured non-JSON outputs such as CSV are modeled as serializers over the canonical payload schema.
- Trail does not require users to model raw CSV strings as their primary response schema.
- For formats like CSV or plain text, Trail validates the canonical payload and then applies the selected serializer.
- Adapters such as `csv()` and `text()` take a **user-defined function** that maps the **validated canonical value** to that representation (headers, row order, delimiters, escaping). Trail does not guess CSV layout from the schema alone; the function is the contract for how structure becomes wire-format text.
- **Advanced (Level 3) authoring:** When the canonical schema is built from **OpenAPI-style helpers** (`anyOf`, `allOf`, `nullable`, and other supported composition helpers), Trail infers the **validated payload TypeScript type** from that composition. Serializer and parser callbacks are typed against that same inferred shape; you supply the mapping to or from the wire format for every case the schema allows. Trail does not expose a public `oneOf` route response helper in v1; developers should model different same-status outcomes as named response variants, and Trail generates OpenAPI `oneOf` automatically when needed.

### Binary and File Responses

- Binary and file responses are declared through explicit media types.
- File and binary outputs are represented as response descriptors rather than normal object schemas for the raw bytes.
- OpenAPI output for binary content maps to `type: string` and `format: binary`.

### Same-Status OpenAPI Merging

- Multiple declared response variants may share the same HTTP status.
- Trail keeps those variants separate in the generated runtime union by `type`.
- In OpenAPI, Trail generates a single response entry per status code.
- If same-status variants differ by payload shape, the documented schema uses `oneOf`.
- If same-status variants expose different media types, Trail merges them under the same status entry and media-type map.
- The same merge rule applies across route responses, middleware rejects, and global errors.

---

## HTTP Method Rules Still Relevant Here

### `DELETE`

- `DELETE` may return `204` with no body or `200` with a response body.
- Trail defaults depend on whether a success schema exists.

### `OPTIONS`

- `OPTIONS` is auto-handled by default.
- Trail should generate standard method and `Allow` behavior automatically.
- A user-defined `options.ts` may override the automatic behavior when custom logic is needed.

### Other Method Rules

- Trail allows request bodies on `POST`, `PUT`, and `PATCH`.
- Trail does not allow request bodies on `GET` or `HEAD` in v1.
- `GET` is a strict route-level read contract.
- `HEAD` is auto-derived from `GET`.
- `PUT` means full replacement.
- `PATCH` means partial update.
- If a path exists but the method is not supported, Trail returns `405 Method Not Allowed`.

---

## Error Format and Override Model

Trail ships with a built-in public error format and helpers, but the user may replace the public-facing standard.

Default behavior:

- Trail provides a built-in `problem(...)` helper for defining problem-details-based error schemas.
- Trail uses `application/problem+json` for framework-generated errors by default.
- Trail also uses `application/problem+json` for declared business errors when those errors are modeled with the problem-details shape.
- Public API error responses include a neutral machine-readable `code` field.
- From **`run`** or application code that opts into route response unions, declared business errors use **`{ type, data }`**. **`data`** carries problem fields only (**`title`**, **`detail`**, **`instance`**, optional RFC **`type`**, **`code`**, extensions); **HTTP `status` is not part of `data`**—it comes from the matching **`responses`** entry (and from **`problem(...)`** defaults) when Trail builds the wire response.

Override behavior:

- Users may provide their own public error format standard.
- Users may provide their own helper layer instead of using Trail's built-in problem helper.
- Framework configuration may remap framework-generated public error responses into the user-selected public format.
- Trail keeps internal framework classification separate from the public error body.

Implementation direction:

- This public error format remapping can be implemented through a dependency-injection-style configuration boundary.

### Validation and Error Surface

- Unknown field behavior is owned by the schema library.
- Trail does not impose its own unknown-field policy for request bodies.
- Validation errors must include clear field paths.
- Trail should surface validation errors in a structure close to Zod 4 issue reporting.
- Validation errors should make it obvious whether the issue came from `params`, `query`, `headers`, `cookies`, or `body`.
- For structured machine-readable validation errors, Trail should align with Zod 4 `issues` output and preserve path information.
- For nested traversal and tooling, Trail should align with Zod 4 `treeifyError()`.
- For console and development output, Trail should align with Zod 4 `prettifyError()` style.
- Trail should avoid including raw input values in validation errors by default.
- In production, unhandled errors return a generic message by default.
- This behavior is configurable through the framework error handler.
- Trail uses framework defaults unless the user provides their own error handler configuration.

### Headers and Cookies

- Trail normalizes header names to lowercase everywhere.
- Headers are exposed to schemas, middleware, and handlers in lowercase form only.
- Cookies are a first-class optional validated input.
- Routes may define `input.cookies` when they want validated cookie input.
- Parsed cookies are also available in raw form through `ctx.request.cookies`.
- Session and authentication cookie handling is expected to live primarily in middleware.

### Logging Direction

- Error logging should be visible in development by default.
- Logger integration should remain replaceable.
- Trail should define a logger interface inspired by Pino-style levels and hierarchy.
- Custom user loggers must implement the Trail logger interface.
- The full logging contract is deferred to the runtime and operations design.

---

## Request Content Enforcement and Multipart

### Content-Type and Accept Enforcement

- Trail rejects request bodies whose `Content-Type` does not match the declared or supported input format.
- Trail prefers strict content-type enforcement rather than guessing unsupported request formats.
- If a request has a body and no `Content-Type`, Trail rejects the request by default.
- If a request has no body, `Content-Type` is not required.
- Trail enforces the request `Accept` header against the route's declared response content types.
- If none of the declared response content types are acceptable, Trail returns `406 Not Acceptable`.

### Request Size Limits

- Trail supports a global request body size limit.
- Trail also supports per-route request body size overrides.
- Per-route limits are intended for cases where one endpoint legitimately needs a larger request body than the global default.

### Multipart and File Input

- Trail v1 supports `multipart/form-data`.
- Uploaded files are modeled as a separate first-class input section through `input.files`.
- Trail does not mix uploaded file objects into normal structured `input.body` validation.
- `input.body` is used for validated non-file form fields.
- `input.files` is used for uploaded file declarations.
- Multipart parsing is explicit and route-scoped.
- Trail parses multipart input only when the route declares multipart or file input support.
- If a route does not declare multipart support, Trail rejects multipart input for that route.

### File Processing Model

- File declarations remain purely declarative in the route input contract.
- File processing happens through dedicated middleware or processor layers, not through arbitrary middleware functions attached directly to file field declarations.
- File processors consume declared `input.files` values and write typed processed results into `ctx.state`.
- This processing layer may upload to S3, write to disk, buffer in memory, or perform other file handling logic.
- Services should receive typed processed metadata or typed processed content through `ctx.state` rather than being forced to work with raw transport-level file objects by default.
- File processing middleware may reject early if processing fails.
- File processing middleware should integrate with the normal middleware typing and `ctx.state` enrichment model.
- Field-level configuration may reference a processor strategy, but execution belongs to the dedicated processing layer rather than inline field middleware.
- Trail should support limits for file count, file size, and allowed MIME types.
- Trail should reject unexpected file fields by default.
- Trail should avoid implicit disk writes by default.

### Request Cancellation

- Request cancellation or disconnect signals are part of the public Trail API.
- Trail should expose cancellation to middleware, handlers, and file processors.
- If the client disconnects, Trail should attempt to stop framework-controlled work when possible.
- User code is still expected to cooperate with cancellation for downstream work such as storage uploads or processing tasks.

---

## OpenAPI Integration

Trail's OpenAPI output is the merge of:

- route responses
- middleware rejects
- global errors

Rules:

- Runtime variants remain separate by `type`.
- OpenAPI may document only one response entry per status code.
- Same-status variants are merged into one documented status entry.
- If same-status variants have different schemas, OpenAPI uses `oneOf`.
- If same-status variants have different media types, OpenAPI merges them under the same status entry.

---

## Consolidated multi-representation example

This section ties together **Level 3 (advanced)** response authoring, the **`{ type, data }`** runtime return shape, the **application boundary**, **content negotiation**, and **OpenAPI same-status merging**.

What this example illustrates:

- **Parent + child segments**: **`routes/users/route.ts`** holds **collection** methods (**`post` create → `201`**, list **`get`**, …). **`routes/users/$id/route.ts`** is the **dynamic item** file only: **`defineRoute({ params, methods: { get, … } })`** so path params are shared—never a one-off `get.ts` per verb.
- **Resource route file**: Each segment is one module; the item example below is `routes/users/$id/route.ts` using **`params` + `methods.get`**.
- **Level 3**: `responses` entries declare explicit `status`, `schema`, and `content` adapters (`json()`, `csv()`, `text()`, `binaryFile()`, `problem()`), matching the advanced authoring rules earlier in this document.
- **GET read contract**: Treat the handler as a `GET` for that resource (`GET` is a strict route-level read; no request body). The verb comes from **`methods.get`** inside **`defineRoute`** on the item file (for example `routes/users/$id/route.ts`), not from a `method` field on each `createRoute`.
- **Canonical payload**: `success` and `avatarDownload` both use **HTTP 200** but different variant discriminants (`type`), different canonical schemas, and different media types. Runtime keeps them distinct by `type`; OpenAPI merges them under a single **`200`** entry (see OpenAPI note below).
- **Query-shaped outcomes**: A validated **query** flag (`format=avatar` vs default profile) drives whether application code loads **profile fields** or **avatar bytes**; the returned **`type`** is still `success` vs `avatarDownload` according to that intent.
- **Application return type (optional)**: Application code can **`import` the response union Trail generates** for that route (name and import path are tooling details) and return **`Promise<ThatUnion>`**, using `{ type, data }` directly. **`run`** can then forward that result with no extra mapping. Other teams may prefer a **domain-only union** and a thin **`run`** that maps into `{ type, data }`; Trail allows both and does not generate or own application services.
- **Negotiation**: The response builder chooses a representation from **`Accept`**; if the client cannot accept any declared representation for the chosen variant, Trail responds with **`406 Not Acceptable`** (per the request `Accept` enforcement rules earlier in this document).
- **Validation**: Output validation follows the response builder rules (strict in development, configurable in production).

### Route definition example

```ts
const UserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string().email(),
});

const ProblemBaseExtensions = {
	code: z.string(),
};

export default defineRoute({
	params: z.object({
		id: z.string(),
	}),
	methods: {
		get: createRoute({
			input: {
				query: z.object({
					// `GET ...?format=avatar` asks for the PNG avatar payload; omit or `profile` for the user row.
					format: z.enum(["profile", "avatar"]).optional(),
				}),
			},

			responses: {
				success: {
					status: 200,
					schema: UserSchema,
					content: {
						"application/json": json(),
						"text/csv": csv((user) =>
							["id,name,email", `${user.id},${user.name},${user.email}`].join(
								"\n",
							),
						),
						"text/plain": text(
							(user) => `${user.id} | ${user.name} | ${user.email}`,
						),
					},
				},

				avatarDownload: {
					status: 200,
					schema: z.object({
						file: z.instanceof(Uint8Array),
						filename: z.string(),
					}),
					content: {
						"image/png": binaryFile({
							body: "file",
							filename: "filename",
						}),
					},
				},

				userNotFound: {
					status: 404,
					schema: problem({
						title: "User not found",
						status: 404,
						extensions: {
							...ProblemBaseExtensions,
							userId: z.string(),
						},
					}),
					content: {
						"application/problem+json": json(),
					},
				},

				emailConflict: {
					status: 409,
					schema: problem({
						title: "Email already exists",
						status: 409,
						extensions: {
							...ProblemBaseExtensions,
							email: z.string().email(),
						},
					}),
					content: {
						"application/problem+json": json(),
					},
				},
			},

			run: async ({ params, input }) => {
				return loadUserProfile(params.id, {
					wantAvatar: input.query.format === "avatar",
				});
			},
		}),
	},
});
```

### Generated route handler return type

Trail generates a discriminated union from the `responses` keys. **`run`**, route handlers, and any application code that chooses this style return that shape. The type is **importable** next to the route (exact export name and path are implementation details); the explicit union below is what that generated type **means** for this example:

```ts
type RouteResponse =
	| {
			type: "success";
			data: {
				id: string;
				name: string;
				email: string;
			};
	  }
	| {
			type: "avatarDownload";
			data: {
				file: Uint8Array;
				filename: string;
			};
	  }
	| {
			type: "userNotFound";
			data: {
				type?: string;
				title: string;
				detail?: string;
				instance?: string;
				code: string;
				userId: string;
			};
	  }
	| {
			type: "emailConflict";
			data: {
				type?: string;
				title: string;
				detail?: string;
				instance?: string;
				code: string;
				email: string;
			};
	  };
```

### Service example (import the generated response union)

Here application code **imports** the framework-generated union (this document calls it `RouteResponse`; Trail may emit `GetUserProfileResponse`, `typeof route.$inferResponse`, or another stable alias). That code returns **`Promise<RouteResponse>`** using **`{ type, data }`** so it stays aligned with the route contract. **`run`** forwards **validated** segment **`params`** (from **`defineRoute`**) and **`input.query`** into the application code. For problem-style errors, **`data`** omits **HTTP `status`**; Trail fills status (and any defaults from `problem(...)`) from the **`responses`** entry when building the wire response.

```ts
// Illustrative: Trail emits an importable type for this route’s responses.
import type { RouteResponse } from "./route.types";

type LoadUserProfileOptions = {
	/** When true, load avatar bytes for the user instead of returning the profile row. */
	wantAvatar: boolean;
};

export async function loadUserProfile(
	id: string,
	opts: LoadUserProfileOptions,
): Promise<RouteResponse> {
	if (id === "missing") {
		return {
			type: "userNotFound",
			data: {
				title: "User not found",
				code: "USER_NOT_FOUND",
				userId: id,
			},
		};
	}
	if (id === "taken") {
		return {
			type: "emailConflict",
			data: {
				title: "Email already exists",
				code: "EMAIL_CONFLICT",
				email: "ada@example.com",
			},
		};
	}
	if (opts.wantAvatar) {
		return {
			type: "avatarDownload",
			data: {
				file: await loadAvatarBytes(id),
				filename: `${id}.png`,
			},
		};
	}
	return {
		type: "success",
		data: {
			id,
			name: "Ada",
			email: "ada@example.com",
		},
	};
}
```

### Alternative: domain outcomes and a thin `run`

If you want application code **not** to mention route response keys, return a **domain-only union** (for example `kind: "ok" | "missing" | ...`) from `loadUserProfile`, then map in **`run`** into `{ type, data }`. That keeps HTTP variant names out of application code at the cost of a small adapter in the route. Both patterns are valid; pick one per module or team convention.

### Response builder flow (same route)

For a single request, Trail applies the variant-driven pipeline from **Response builder** above:

1. Receive `{ type, data }` from `run`.
2. Resolve the declared response variant for that `type`.
3. Validate `data` against the variant schema (strict in development; configurable in production).
4. Negotiate the response representation using the request **`Accept`** header and the variant’s declared `content` map (mismatch → **`406 Not Acceptable`** when no declared type is acceptable).
5. Serialize the **same** canonical `data` value into the selected representation (`json` / `csv` / `text` / `binaryFile` adapters).
6. Set status line, headers, and cookies from the normalized response model.
7. Write the body (skipped for `204`; not used in this example).

### OpenAPI shape example

Because **`success`** and **`avatarDownload`** both declare **status `200`**, OpenAPI documents **one** `200` response. Runtime still discriminates with `type: "success" | "avatarDownload"`. Media types from both variants appear under the merged `200.content` map. Here each media type maps to a single canonical shape (JSON/CSV/plain → user row; PNG → binary); if two variants at the same status both contributed incompatible schemas for the **same** media type, the documented schema for that media type would use **`oneOf`**.

```yaml
responses:
  "200":
    description: >
      Merged from response keys `success` and `avatarDownload`.
      Runtime union discriminates with `type`.
    content:
      application/json:
        schema:
          $ref: "#/components/schemas/User"
      text/csv:
        schema:
          type: string
      text/plain:
        schema:
          type: string
      image/png:
        schema:
          type: string
          format: binary
  "404":
    content:
      application/problem+json:
        schema:
          $ref: "#/components/schemas/UserNotFoundProblem"
  "409":
    content:
      application/problem+json:
        schema:
          $ref: "#/components/schemas/EmailConflictProblem"
```

---

## Group 1 Checklist

- [x] HTTP method semantics defined
- [x] Success status defaults defined
- [x] `DELETE` optional-body rule defined
- [x] `OPTIONS` auto-handling rule defined
- [x] Response authoring levels defined
- [x] Runtime `{ type, data }` model defined
- [x] Response builder behavior defined
- [x] Strict request parser boundary defined
- [x] Approved built-in v1 content types defined
- [x] Multi-content response negotiation defined
- [x] Same-status OpenAPI merge rule defined
- [x] Header normalization defined
- [x] Cookie input model defined
- [x] Validation/error surface defined
- [x] Public error code and internal classification split defined
- [x] `Content-Type` and `Accept` enforcement defined
- [x] Global and per-route body limits defined
- [x] Multipart/file input model defined
- [x] File processing middleware model defined
- [x] Request cancellation behavior defined

---

## Outcome

Group 1 now has:

- clear HTTP method semantics
- strict request parsing and content enforcement
- normalized response authoring across three levels
- multi-representation response support
- problem-details-based default errors with override capability
- multipart and file input support direction
- cancellation and request lifecycle decisions
