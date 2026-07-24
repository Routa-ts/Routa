import { z } from "zod";

export const LoggerOperation = z.enum([
	"log",
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
	"silent",
	"child",
	"bindings",
	"isLevelEnabled",
]);

export const LoggerLevel = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

export const LoggerShowcaseBody = z.object({
	operation: LoggerOperation,
	level: LoggerLevel,
});

export const LoggerShowcaseSuccess = z.object({
	operation: LoggerOperation,
	checkedLevel: LoggerLevel,
	checkedLevelEnabled: z.boolean(),
	operationLogEmitted: z.boolean(),
	childBindingsConfirmed: z.object({
		showcase: z.boolean(),
		requestId: z.boolean(),
	}),
	note: z.string(),
});

export const LoggerShowcaseDisabled = z.object({
	message: z.string(),
});
