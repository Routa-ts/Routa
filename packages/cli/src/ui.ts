// The CLI and create-routa-ts share one terminal UI implementation; create-routa-ts
// owns it because it is also used by the standalone `pnpm create routa-ts` flow.
export { createUi, shouldUseColor, type Ui } from "create-routa-ts";
