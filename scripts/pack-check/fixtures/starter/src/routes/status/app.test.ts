import { expect, it } from "vitest";
import { createTestApp } from "../../../.routa/testing.gen.js";

it("serves GET /status in memory", async () => {
	const app = await createTestApp();

	try {
		const response = await app.request("/status");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	} finally {
		await app.dispose();
	}
});
