import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	type ApplicationServicesDeclaration,
	createApplication,
	createHonoApp,
	type HonoRoute,
} from "./hono.js";
import {
	type AnyMiddlewareContract,
	type ApplicationServicesFactory,
	createMiddleware,
	createRoute,
	defineServices,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

/** Type fixtures: compiled, never run. */
function typesOnly(_check: () => void): void {}

const servicesRoute = (run: (ctx: Record<string, unknown>) => unknown): HonoRoute => ({
	method: "get",
	path: "/services",
	contract: createRoute({
		responses: { ok: { status: 200, schema: z.unknown() } },
		run: ({ ctx }) => ({ type: "ok", data: run(ctx as Record<string, unknown>) }),
	}),
});

const declaration = (
	names: readonly string[],
	factory: ApplicationServicesFactory<any>,
): ApplicationServicesDeclaration => ({ names, factory });

const get = (app: { fetch: (request: Request) => Promise<Response> }) =>
	app.fetch(new Request("http://localhost/services"));

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("application services (runtime)", () => {
	it("leaves ctx.services absent when no services are configured", async () => {
		const app = await createApplication([servicesRoute((ctx) => "services" in ctx)]);

		expect(await (await get(app)).json()).toBe(false);
		await app.dispose();
	});

	it("runs a sync or async factory once per application, before any request", async () => {
		for (const sync of [true, false]) {
			let constructed = 0;
			const factory = () => {
				constructed += 1;
				const services = { counter: { value: constructed } };
				return sync ? services : Promise.resolve(services);
			};
			const app = await createApplication(
				[servicesRoute((ctx) => (ctx.services as { counter: { value: number } }).counter.value)],
				{ services: declaration(["counter"], factory) },
			);

			expect(constructed).toBe(1);
			expect(await (await get(app)).json()).toBe(1);
			expect(await (await get(app)).json()).toBe(1);
			expect(constructed).toBe(1);
			await app.dispose();
		}
	});

	it("gives each application instance its own services", async () => {
		let constructed = 0;
		const services = declaration(["store"], () => ({ store: { id: ++constructed } }));
		const route = servicesRoute((ctx) => (ctx.services as { store: { id: number } }).store.id);
		const first = await createApplication([route], { services });
		const second = await createApplication([route], { services });

		expect(await (await get(first)).json()).toBe(1);
		expect(await (await get(second)).json()).toBe(2);
		await Promise.all([first.dispose(), second.dispose()]);
	});

	it("shares one instance between services a factory wires together", async () => {
		class Clock {
			now() {
				return 42;
			}
		}
		class Audit {
			constructor(readonly clock: Clock) {}
		}
		const app = await createApplication(
			[
				servicesRoute((ctx) => {
					const services = ctx.services as { clock: Clock; audit: Audit };
					return services.audit.clock === services.clock;
				}),
			],
			{
				services: declaration(["audit", "clock"], () => {
					const clock = new Clock();
					return { clock, audit: new Audit(clock) };
				}),
			},
		);

		expect(await (await get(app)).json()).toBe(true);
		await app.dispose();
	});

	it("passes the configured logger and onCleanup to the factory", async () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({ sink: (event) => events.push(event) });
		const app = await createApplication([], {
			logger,
			services: declaration([], ({ logger: factoryLogger, onCleanup }) => {
				factoryLogger.info("services.ready", "Services ready.");
				expect(typeof onCleanup).toBe("function");
				return {};
			}),
		});

		expect(events.map((event) => event.event)).toEqual(["services.ready"]);
		await app.dispose();
	});

	it("freezes the mapping without freezing the services", async () => {
		const counter = { hits: 0 };
		const app = await createApplication(
			[
				servicesRoute((ctx) => {
					const services = ctx.services as { counter: typeof counter };
					services.counter.hits += 1;
					return {
						frozen: Object.isFrozen(services),
						replaced: Reflect.set(services, "counter", { hits: 99 }),
						hits: services.counter.hits,
					};
				}),
			],
			{ services: declaration(["counter"], () => ({ counter })) },
		);

		expect(await (await get(app)).json()).toEqual({ frozen: true, replaced: false, hits: 1 });
		expect(counter.hits).toBe(1);
		await app.dispose();
	});

	it("rejects a mapping whose names differ from the contract, after running its cleanup", async () => {
		for (const [services, message] of [
			[{ clock: 1 }, 'missing "store"'],
			[{ clock: 1, store: 2, extra: 3 }, 'unexpected "extra"'],
			[null, "received null"],
			[[1], "received an array"],
		] as const) {
			let cleaned = 0;
			const failure = createApplication([], {
				services: declaration(["clock", "store"], ({ onCleanup }) => {
					onCleanup(() => {
						cleaned += 1;
					});
					return services;
				}),
			});

			await expect(failure).rejects.toThrow(message);
			expect(cleaned).toBe(1);
		}
	});

	it("does not validate service members at runtime", async () => {
		const app = await createApplication(
			[servicesRoute((ctx) => typeof (ctx.services as { clock: unknown }).clock)],
			{ services: declaration(["clock"], () => ({ clock: "not a clock" })) },
		);

		expect(await (await get(app)).json()).toBe("string");
		await app.dispose();
	});
});

describe("application service cleanup", () => {
	it("releases resources in reverse registration order on dispose", async () => {
		const released: string[] = [];
		const app = await createApplication([], {
			services: declaration(["cache", "db"], async ({ onCleanup }) => {
				onCleanup(() => {
					released.push("db");
				});
				onCleanup(async () => {
					await Promise.resolve();
					released.push("cache");
				});
				return { db: {}, cache: {} };
			}),
		});

		expect(released).toEqual([]);
		await app.dispose();
		expect(released).toEqual(["cache", "db"]);
	});

	it("releases what a failing factory acquired and keeps the factory error primary", async () => {
		const events: RoutaLogEvent[] = [];
		const released: string[] = [];
		const primary = new Error("cache unavailable");
		const failure = createApplication([], {
			logger: createLogger({ sink: (event) => events.push(event) }),
			services: declaration(["cache", "db"], async ({ onCleanup }) => {
				onCleanup(() => {
					released.push("db");
				});
				onCleanup(() => {
					throw new Error("db close failed");
				});
				onCleanup(() => {
					released.push("pool");
				});
				throw primary;
			}),
		});

		await expect(failure).rejects.toBe(primary);
		expect(released).toEqual(["pool", "db"]);
		expect(events).toMatchObject([
			{
				event: "services.cleanup_failed",
				level: "error",
				data: { failures: [{ error: "db close failed" }] },
			},
		]);
	});

	it("never retries a failing factory", async () => {
		let attempts = 0;
		const failure = createApplication([], {
			services: declaration(["db"], () => {
				attempts += 1;
				throw new Error("db unavailable");
			}),
		});

		await expect(failure).rejects.toThrow("db unavailable");
		expect(attempts).toBe(1);
	});

	it("releases the services when route registration fails", async () => {
		let released = 0;
		const failure = createApplication(
			[
				{
					method: "get",
					path: "/broken",
					contract: { responses: { ok: { status: 100 } }, run: () => ({ type: "ok" }) },
				},
			],
			{
				services: declaration(["db"], ({ onCleanup }) => {
					onCleanup(() => {
						released += 1;
					});
					return { db: {} };
				}),
			},
		);

		await expect(failure).rejects.toThrow("Informational (1xx)");
		expect(released).toBe(1);
	});

	it("attempts every callback and rejects dispose with all cleanup failures", async () => {
		const released: string[] = [];
		const app = await createApplication([], {
			services: declaration([], ({ onCleanup }) => {
				onCleanup(() => {
					released.push("first");
				});
				onCleanup(() => Promise.reject(new Error("second failed")));
				onCleanup(() => {
					throw new Error("third failed");
				});
				return {};
			}),
		});

		const disposal = app.dispose();

		await expect(disposal).rejects.toBeInstanceOf(AggregateError);
		await expect(disposal).rejects.toMatchObject({
			errors: [{ message: "third failed" }, { message: "second failed" }],
		});
		expect(released).toEqual(["first"]);
	});

	it("shares one disposal between repeated and concurrent calls", async () => {
		let released = 0;
		const app = await createApplication([], {
			services: declaration([], ({ onCleanup }) => {
				onCleanup(() => {
					released += 1;
					throw new Error("close failed");
				});
				return {};
			}),
		});

		const first = app.dispose();
		const second = app.dispose();

		expect(second).toBe(first);
		await expect(first).rejects.toBeInstanceOf(AggregateError);
		expect(app.dispose()).toBe(first);
		await expect(app.dispose()).rejects.toBeInstanceOf(AggregateError);
		expect(released).toBe(1);
	});

	it("releases cleanup registered while draining and refuses it once cleanup started", async () => {
		const released: string[] = [];
		let register: ((callback: () => void) => void) | undefined;
		const app = await createApplication([], {
			services: declaration([], ({ onCleanup }) => {
				register = onCleanup;
				return {};
			}),
		});

		const disposal = app.dispose();
		register?.(() => {
			released.push("acquired while draining");
		});
		await disposal;

		expect(released).toEqual(["acquired while draining"]);
		expect(() => register?.(() => {})).toThrow("onCleanup() was called after cleanup started");
	});

	it("drains accepted requests before releasing services and rejects new ones", async () => {
		const order: string[] = [];
		const gate = deferred();
		const app = await createApplication(
			[
				{
					method: "get",
					path: "/slow",
					contract: createRoute({
						responses: { ok: { status: 200, schema: z.string() } },
						run: async () => {
							await gate.promise;
							order.push("request settled");
							return { type: "ok", data: "done" };
						},
					}),
				},
			],
			{
				services: declaration(["db"], ({ onCleanup }) => {
					onCleanup(() => {
						order.push("services released");
					});
					return { db: {} };
				}),
			},
		);

		const accepted = app.fetch(new Request("http://localhost/slow"));
		let disposed = false;
		const disposal = app.dispose().then(() => {
			disposed = true;
		});

		await expect(app.fetch(new Request("http://localhost/slow"))).rejects.toThrow(
			"accepts no new requests",
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(disposed).toBe(false);
		expect(order).toEqual([]);

		gate.resolve();
		expect(await (await accepted).json()).toBe("done");
		await disposal;
		expect(order).toEqual(["request settled", "services released"]);
	});
});

describe("defineServices (types)", () => {
	it("checks factories against a fixed required contract", () => {
		typesOnly(() => {
			interface Clock {
				now(): number;
			}
			interface AppServices {
				clock: Clock;
				name: string;
			}
			const defineAppServices = defineServices<AppServices>();

			defineAppServices(() => ({ clock: { now: () => 1 }, name: "api" }));
			defineAppServices(async ({ logger, onCleanup }) => {
				logger.info("services.start", "Starting.");
				onCleanup(async () => {});
				return { clock: { now: () => 1 }, name: "api" };
			});
			defineServices<AppServices>()(() => ({ clock: { now: () => 1 }, name: "api" }));

			// @ts-expect-error A factory must return every declared service.
			defineAppServices(() => ({ clock: { now: () => 1 } }));
			// @ts-expect-error Each service must satisfy its declared interface.
			defineAppServices(() => ({ clock: { now: () => "1" }, name: "api" }));

			// @ts-expect-error A contract lists required services only.
			defineServices<{ clock?: Clock }>();
			// @ts-expect-error A contract names each service instead of an index signature.
			defineServices<Record<string, Clock>>();
			// @ts-expect-error The contract is required.
			defineServices()(() => ({}));
		});
	});
});

describe("reserved ctx.services (types)", () => {
	it("rejects middleware that provides services or passes them to next()", () => {
		typesOnly(() => {
			createMiddleware({
				provides: {
					// @ts-expect-error ctx.services is reserved for injected services.
					services: z.object({ db: z.string() }),
				},
			});

			const namedProvides = { services: z.object({ db: z.string() }) };
			// @ts-expect-error Named provides bindings are checked too.
			createMiddleware({ provides: namedProvides });

			createMiddleware({
				run: ({ next }) =>
					// @ts-expect-error A next() payload cannot claim services.
					next({ services: { db: "fake" } }),
			});

			createMiddleware({
				run: ({ next }) => {
					const payload = { services: { db: "fake" } };
					// @ts-expect-error Named next() payloads are checked too.
					return next(payload);
				},
			});

			createMiddleware({
				provides: { user: z.string() },
				run: ({ next }) =>
					// @ts-expect-error A next() payload cannot claim services beside provided context.
					next({ user: "u1", services: { db: "fake" } }),
			});

			// Ordinary middleware keeps its inference.
			createMiddleware({ run: ({ next }) => next() });
			createMiddleware({ run: ({ next }) => next({ requestId: "r1" }) });
			createMiddleware({
				provides: { user: z.string() },
				run: ({ next }) => next({ user: "u1" }),
			});
		});
	});
});

describe("reserved ctx.services (runtime)", () => {
	const ok = (middleware: AnyMiddlewareContract[], run = () => "handled") =>
		createRoute({
			middleware,
			responses: { ok: { status: 200, schema: z.string() } },
			run: () => ({ type: "ok", data: run() }),
		});
	const withServices = { services: declaration(["db"], () => ({ db: {} })) };

	it("rejects middleware that provides services through a compiler bypass", async () => {
		const bypass = createMiddleware({
			provides: { services: z.unknown() } as Record<string, z.ZodTypeAny>,
		});
		const route: HonoRoute = { method: "get", path: "/", contract: ok([bypass]) };

		expect(() => createHonoApp([route])).toThrow(
			"middleware[0] on GET / provides ctx.services, which Routa reserves for injected services.",
		);
		await expect(createApplication([route], withServices)).rejects.toThrow("provides ctx.services");
	});

	it("fails a request whose context claims services, with or without application services", async () => {
		const passesServices = createMiddleware({
			run: ({ next }) => next({ services: { db: "fake" } } as any),
		});
		const writesServices = createMiddleware({
			run: ({ ctx, next }) => {
				(ctx as Record<string, unknown>).services = { db: "fake" };
				return next();
			},
		});
		let handled = 0;
		const handler = () => {
			handled += 1;
			return "handled";
		};

		for (const options of [{}, withServices]) {
			const app = await createApplication(
				[
					{ method: "get", path: "/next", contract: ok([passesServices], handler) },
					{ method: "get", path: "/write", contract: ok([writesServices], handler) },
					{
						method: "get",
						path: "/context",
						contract: ok([], handler),
						createContext: () => ({ services: { db: "fake" } }),
					},
				],
				options,
			);

			for (const path of ["/next", "/write", "/context"]) {
				const response = await app.fetch(new Request(`http://localhost${path}`));
				expect(response.status, path).toBe(500);
			}
			await app.dispose();
		}

		expect(handled).toBe(0);
	});

	it("keeps the handler's ctx.services fixed", async () => {
		const app = await createApplication(
			[
				servicesRoute((ctx) => {
					const original = ctx.services;
					return {
						reassigned: Reflect.set(ctx, "services", {}),
						deleted: Reflect.deleteProperty(ctx, "services"),
						kept: ctx.services === original,
					};
				}),
			],
			withServices,
		);

		expect(await (await get(app)).json()).toEqual({
			reassigned: false,
			deleted: false,
			kept: true,
		});
		await app.dispose();
	});
});
