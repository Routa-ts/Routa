// The CLI and create-routa share one terminal UI implementation; create-routa
// owns it because it is also used by the standalone `pnpm create routa` flow.
export { createUi, shouldUseColor, type Ui } from "create-routa";
