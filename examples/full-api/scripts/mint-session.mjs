#!/usr/bin/env node
/**
 * Mint a demo session cookie for local try-outs.
 *
 * Usage:
 *   ROUTA_DEMO_SESSION_SECRET=dev-secret node scripts/mint-session.mjs admin
 *   ROUTA_DEMO_SESSION_SECRET=dev-secret node scripts/mint-session.mjs acme:writer
 */
import { createHmac } from "node:crypto";

const secret = process.env.ROUTA_DEMO_SESSION_SECRET;
const userId = process.argv[2];

if (!secret) {
	console.error("Set ROUTA_DEMO_SESSION_SECRET before minting a session.");
	process.exit(1);
}

if (!userId) {
	console.error("Usage: node scripts/mint-session.mjs <userId>");
	process.exit(1);
}

const signature = createHmac("sha256", secret).update(userId).digest("base64url");
const token = `demo-user:${userId}.${signature}`;

console.log(token);
