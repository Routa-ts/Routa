import { z } from "zod";

export const ListAuditEventsQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const AuditEvent = z.object({
	id: z.string(),
	actorId: z.string(),
	action: z.string(),
});

export const ListAuditEventsResponse = z.object({ events: z.array(AuditEvent) });
