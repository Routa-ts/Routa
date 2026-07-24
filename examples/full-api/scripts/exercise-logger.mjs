const operations = [
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
];
const endpoint = `http://127.0.0.1:${process.env.PORT ?? "3000"}/logger-showcase`;

for (const operation of operations) {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operation, level: "debug" }),
	});
	const body = await response.json();

	if (!response.ok) {
		throw new Error(`${operation} failed with ${response.status}: ${JSON.stringify(body)}`);
	}

	console.log(`${operation}: ${JSON.stringify(body)}`);
}
