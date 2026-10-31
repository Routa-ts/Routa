import type { ApplicationServicesFactory, OnCleanup, RequestServicesFactory } from "./index.js";
import type { RoutaLogger } from "./logger.js";

/** A frozen service mapping, as handlers receive it on `ctx.services`. */
export type ServiceMapping = Readonly<Record<string, unknown>>;

/** The application services factory and the names its contract declares. */
export type ApplicationServicesDeclaration = {
	readonly factory: ApplicationServicesFactory;
	/** The contract's service names, which `routa generate` reads from source. */
	readonly names: readonly string[];
};

/** A route-file or method services factory, the names its contract declares, and where it runs. */
export type RequestServicesDeclaration = {
	readonly factory: RequestServicesFactory;
	/** The contract's service names, which `routa generate` reads from source. */
	readonly names: readonly string[];
	/**
	 * How many middleware at the start of the route's chain run before the factory: the filesystem
	 * middleware for route-file services, and those plus the route file's for method services.
	 */
	readonly after: number;
};

/** The cleanup callbacks one service scope registered, released at most once. */
export type CleanupScope = {
	readonly onCleanup: OnCleanup;
	/**
	 * Awaits every registered callback in reverse registration order, attempting each one even
	 * after a failure. Rejects with an `AggregateError` of the failures once all have run. Repeated
	 * and concurrent calls share the first call's outcome.
	 */
	release(): Promise<void>;
};

export function createCleanupScope(): CleanupScope {
	const callbacks: Array<() => unknown> = [];
	let released: Promise<void> | undefined;

	return {
		onCleanup: (callback) => {
			if (typeof callback !== "function") {
				throw new TypeError("onCleanup() expects a function.");
			}

			if (released) {
				throw new Error(
					"onCleanup() was called after cleanup started. Register cleanup as soon as the factory acquires the resource.",
				);
			}

			callbacks.push(callback);
		},
		// Cleanup starts on a later microtask, so a callback that registers more cleanup is refused
		// instead of silently missing the snapshot.
		release: () =>
			(released ??= Promise.resolve().then(() => runCleanup([...callbacks].reverse()))),
	};
}

async function runCleanup(callbacks: ReadonlyArray<() => unknown>): Promise<void> {
	const failures: unknown[] = [];

	for (const callback of callbacks) {
		try {
			await callback();
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(failures, `${failures.length} service cleanup callback(s) failed.`);
	}
}

/**
 * Runs a services factory and checks that it returned exactly the declared services.
 *
 * When the factory or the check fails, the callbacks it already registered run, and the original
 * failure is rethrown. Cleanup failures on that path are logged, never thrown, so they cannot
 * replace the construction error.
 *
 * @param factory - Calls the scope's factory with its context and `onCleanup`
 * @param label - Names the factory in messages, such as `application services factory`
 */
export async function constructServices(
	factory: (onCleanup: OnCleanup) => unknown,
	names: readonly string[],
	label: string,
	scope: CleanupScope,
	logger: RoutaLogger,
): Promise<ServiceMapping> {
	try {
		return exactServices(await factory(scope.onCleanup), names, label);
	} catch (error) {
		await scope.release().catch((cleanupError: unknown) => logCleanupFailure(logger, cleanupError));
		throw error;
	}
}

/** Logs the failures a scope's cleanup reported. */
export function logCleanupFailure(logger: RoutaLogger, error: unknown): void {
	const failures = error instanceof AggregateError ? error.errors : [error];

	logger.error("services.cleanup_failed", "Service cleanup failed.", {
		failures: failures.map((failure) =>
			failure instanceof Error
				? { error: failure.message, name: failure.name, stack: failure.stack }
				: { error: String(failure) },
		),
	});
}

/**
 * Checks a factory result against the declared names, then copies and freezes it. The services
 * themselves are not frozen, so their own state stays mutable.
 *
 * @throws {TypeError} When the result is not an object, or its names differ from the declared ones
 */
export function exactServices(
	value: unknown,
	names: readonly string[],
	label: string,
): ServiceMapping {
	const declared = quotedList(names);

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(
			`The ${label} must return an object with the declared services (${declared}), received ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}.`,
		);
	}

	const missing = names.filter((name) => !Object.hasOwn(value, name));
	const unexpected = Object.keys(value).filter((name) => !names.includes(name));

	if (missing.length > 0 || unexpected.length > 0) {
		const problems = [
			...(missing.length > 0 ? [`missing ${quotedList(missing)}`] : []),
			...(unexpected.length > 0 ? [`unexpected ${quotedList(unexpected)}`] : []),
		];

		throw new TypeError(
			`The ${label} must return exactly the declared services (${declared}): ${problems.join("; ")}.`,
		);
	}

	const services = value as Record<string, unknown>;
	return Object.freeze(Object.fromEntries(names.map((name) => [name, services[name]])));
}

function quotedList(names: readonly string[]): string {
	return names.map((name) => JSON.stringify(name)).join(", ");
}
