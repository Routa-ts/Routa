import type { X509Certificate } from "node:crypto";
import { verifySession } from "./session.js";

/**
 * Looks up who a credential belongs to. The authenticators in `src/routa.ts` call it, so
 * verification stays application code: Routa only finds the credential and calls them.
 */
export interface IdentityDirectory {
	/** The account a signed session token belongs to. */
	accountForSession(token: string): string | undefined;
	/** The account an access token belongs to. */
	accountForToken(token: string): string | undefined;
	/** The service an API key belongs to. */
	serviceForKey(key: string): string | undefined;
	/** The service a client certificate the TLS proxy verified belongs to. */
	serviceForCertificate(certificate: X509Certificate): string | undefined;
}

// Demonstration credentials only. Never ship fixed tokens or keys: a real application stores
// hashed keys, verifies signed or introspected access tokens, and rotates both.
const demoAccountTokens = new Map([
	["demo-token-admin", "admin"],
	["demo-token-acme-writer", "acme:writer"],
]);
const demoServiceKeys = new Map([["demo-key-acme-sync", "acme:sync"]]);
// The subject of scripts/demo-client-cert.pem. A real application pins fingerprints or checks
// the issuing CA, and trusts the header only behind a proxy that overwrites it.
const demoCertificateSubjects = new Map([["CN=reports.demo.invalid", "reports"]]);

/** Fixed showcase identities. A real application would query its account and service store. */
export class DemoIdentityDirectory implements IdentityDirectory {
	accountForSession(token: string): string | undefined {
		return verifySession(token).userId;
	}

	accountForToken(token: string): string | undefined {
		return demoAccountTokens.get(token);
	}

	serviceForKey(key: string): string | undefined {
		return demoServiceKeys.get(key);
	}

	serviceForCertificate(certificate: X509Certificate): string | undefined {
		return demoCertificateSubjects.get(certificate.subject);
	}
}
