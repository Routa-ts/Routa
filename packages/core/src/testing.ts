import {
	createProjectApplication,
	type ProjectModuleLoader,
	type ServiceReplacements,
} from "./project.js";

/**
 * Imports each of a project's modules by its path from the project root. The generated
 * `.routa/testing.gen.ts` lists them, so nothing loads until a test application is created.
 */
export type ProjectModules = Readonly<Record<string, () => Promise<unknown>>>;

/** An isolated, in-memory instance of a Routa project, with its own services and cleanup. */
export type TestApplication = {
	/**
	 * Sends one request through the application's routes and middleware without a network
	 * listener. A path or relative URL resolves against `http://localhost`. It settles after the
	 * request's services are released, and rejects once disposal has started.
	 */
	readonly request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/**
	 * Stops accepting requests, waits for accepted ones and their request cleanup, then releases
	 * the application services once. Repeated and concurrent calls share one outcome. It rejects,
	 * after every cleanup callback has been attempted, when any of them failed. It sets no
	 * deadline: a request or callback that never settles keeps disposal pending.
	 */
	readonly dispose: () => Promise<void>;
};

/**
 * Builds a test application for a project through the same path as `routa start`, with each
 * replaced scope's factory swapped before construction. A replaced scope's original factory never
 * runs; omitted scopes keep theirs and receive the replacements' services. The generated
 * `createTestApp` in `.routa/testing.gen.ts` calls it with the project's modules.
 *
 * @param modules - Imports each project module by its path from the project root
 * @param options - The application services factory, or replacement factories by scope
 * @throws When a replacement names a scope that declares no services, or a factory fails
 */
export async function createTestApplication(
	modules: ProjectModules,
	options?: ServiceReplacements | ((context: never) => unknown),
): Promise<TestApplication> {
	const load: ProjectModuleLoader = (file) => {
		const module = modules[file];

		if (!module) {
			throw new Error(`.routa/testing.gen.ts does not list ${file}. Run routa generate.`);
		}

		return module();
	};
	const { application } = await createProjectApplication(load, {
		runtimeMode: "dev",
		replacements: replacementsFrom(options),
	});

	return Object.freeze({
		request: (input: string | URL | Request, init?: RequestInit) =>
			application.fetch(
				input instanceof Request
					? new Request(input, init)
					: new Request(new URL(input, "http://localhost"), init),
			),
		dispose: application.dispose,
	});
}

/** Reads the shorthand form, a lone application services factory, as `{ services }`. */
function replacementsFrom(options: unknown): ServiceReplacements {
	if (options === undefined) {
		return {};
	}

	if (typeof options === "function") {
		return { services: options };
	}

	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new TypeError(
			"createTestApp() expects an application services factory or { services, routes }.",
		);
	}

	const unexpected = Object.keys(options).filter((key) => key !== "services" && key !== "routes");

	if (unexpected.length > 0) {
		throw new TypeError(
			`createTestApp() accepts only services and routes, received ${unexpected.map((key) => JSON.stringify(key)).join(", ")}.`,
		);
	}

	return options as ServiceReplacements;
}
