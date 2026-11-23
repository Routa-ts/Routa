// Pack check runs this in a built consumer: the compiled test application module serves a
// request without a listener.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { createTestApp } = await import(pathToFileURL(resolve("dist/.routa/testing.gen.js")).href);
const app = await createTestApp();
const response = await app.request("/status");
const body = await response.json();
await app.dispose();
if (response.status !== 200 || body.ok !== true) {
	throw new Error(`Compiled test application got ${response.status} ${JSON.stringify(body)}.`);
}
