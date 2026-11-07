import { requireAuth } from "@routa-ts/core";

/** Tenant data accepts a person's session or a service's API key, never a Bearer token or certificate. */
export const tenantCredentials = requireAuth({ schemes: ["session", "serviceKey"] });

export { withTenant } from "../../../../middleware/tenant.js";
