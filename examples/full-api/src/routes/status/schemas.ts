import { z } from "zod";

export const Status = z.object({
	ok: z.boolean(),
	service: z.string(),
});

export const GetStatusResponse = Status;
