import { requireAuth } from "@routa-ts/core";

/** Every route in `(private)` needs a credential. Any configured scheme is accepted. */
export const signedIn = requireAuth();
