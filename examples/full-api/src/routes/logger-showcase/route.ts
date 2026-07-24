import {
	createRoute,
	createRouteRoot,
	type RoutaLogData,
	type RoutaLogger,
	type RoutaLogLevel,
} from "@routa-ts/core";
import { LoggerShowcaseBody, LoggerShowcaseDisabled, LoggerShowcaseSuccess } from "./schemas.js";

const route = createRouteRoot("/logger-showcase");
const showcaseEnabled = process.env.ROUTA_DEMO_LOGGER_SHOWCASE === "on";

export default route({
	post: createRoute({
		input: {
			body: LoggerShowcaseBody,
		},
		responses: {
			success: {
				status: 200,
				schema: LoggerShowcaseSuccess,
			},
			disabled: {
				status: 403,
				schema: LoggerShowcaseDisabled,
			},
		},
		run: ({ ctx, input }) => {
			if (!showcaseEnabled) {
				return {
					type: "disabled",
					data: {
						message: "Set ROUTA_DEMO_LOGGER_SHOWCASE=on to enable deliberate logger emissions.",
					},
				};
			}

			const child = ctx.logger.child({
				showcase: "logger",
				requestId: ctx.requestId,
			});
			const bindings = child.bindings();
			const checkedLevelEnabled = child.isLevelEnabled(input.body.level);
			const operationLevel = levelForOperation(input.body.operation);
			const operationLogEmitted =
				operationLevel !== "silent" && child.isLevelEnabled(operationLevel);
			const data = {
				operation: input.body.operation,
				checkedLevel: input.body.level,
				checkedLevelEnabled,
			} satisfies RoutaLogData;

			emitShowcaseOperation(child, input.body.operation, data);

			return {
				type: "success",
				data: {
					operation: input.body.operation,
					checkedLevel: input.body.level,
					checkedLevelEnabled,
					operationLogEmitted,
					childBindingsConfirmed: {
						showcase: bindings.showcase === "logger",
						requestId: bindings.requestId === ctx.requestId,
					},
					note:
						input.body.operation === "silent"
							? "silent intentionally emits no route-owned log event."
							: "Emission still respects the configured minimum log level.",
				},
			};
		},
	}),
});

type LoggerOperation = RoutaLogLevel | "silent" | "log" | "child" | "bindings" | "isLevelEnabled";

function levelForOperation(operation: LoggerOperation): RoutaLogLevel | "silent" {
	switch (operation) {
		case "trace":
		case "debug":
		case "info":
		case "warn":
		case "error":
		case "fatal":
		case "silent":
			return operation;
		case "log":
		case "child":
		case "bindings":
		case "isLevelEnabled":
			return "info";
	}
}

function emitShowcaseOperation(
	logger: RoutaLogger,
	operation: LoggerOperation,
	data: RoutaLogData,
): void {
	const event = `logger_showcase.${operation}`;
	const message = `Exercised RoutaLogger.${operation}.`;

	switch (operation) {
		case "log":
			logger.log({
				level: "info",
				event,
				message,
				timestamp: new Date().toISOString(),
				data,
			});
			return;
		case "trace":
		case "debug":
		case "info":
		case "warn":
		case "error":
		case "fatal":
			logger[operation](event, message, data);
			return;
		case "silent":
			logger.silent(event, message, data);
			return;
		case "child":
			logger.info(event, message, { ...data, child: true });
			return;
		case "bindings":
			logger.info(event, message, { ...data, bindingsConfirmed: true });
			return;
		case "isLevelEnabled":
			logger.info(event, message, data);
	}
}
