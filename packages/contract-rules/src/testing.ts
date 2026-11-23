/**
 * Assertions for Routa's own tests. Only test files and pack check import this entry, so no
 * published build carries it.
 */

/** Hex digits and dashes, which a random request ID or UUID can contain by chance. */
const weakSecret = /^[0-9a-fA-F-]*$/;

/**
 * Asserts that `output` never carries `secret`. A string is checked as written and anything else
 * as its JSON, where the secret may also appear escaped. The secret must be at least 8 characters
 * and not only hex digits and dashes, so an ID in the output cannot contain it by chance.
 */
export function expectNoLeak(output: unknown, secret: string): void {
	if (secret.length < 8 || weakSecret.test(secret)) {
		throw new Error(
			`expectNoLeak needs a distinctive secret of at least 8 characters that is not only hex digits and dashes, got ${JSON.stringify(secret)}.`,
		);
	}

	const text = typeof output === "string" ? output : JSON.stringify(output);
	// JSON escapes a quote or backslash in the secret, so look for its escaped form too.
	const forms =
		typeof output === "string" ? [secret] : [secret, JSON.stringify(secret).slice(1, -1)];

	if (forms.some((form) => text.includes(form))) {
		throw new Error(`Expected the output not to contain ${JSON.stringify(secret)}, got:\n${text}`);
	}
}
