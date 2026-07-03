export type Ui = {
	heading: (value: string) => string;
	command: (value: string) => string;
	success: (value: string) => string;
	warn: (value: string) => string;
	error: (value: string) => string;
	muted: (value: string) => string;
};

export function shouldUseColor(): boolean {
	if ("FORCE_COLOR" in process.env) {
		return process.env.FORCE_COLOR !== "0";
	}

	if ("NO_COLOR" in process.env || process.env.CI) {
		return false;
	}

	return Boolean(process.stdout.isTTY);
}

export function createUi(color = false): Ui {
	return {
		heading: style(color, "1;36"),
		command: style(color, "36"),
		success: style(color, "32"),
		warn: style(color, "33"),
		error: style(color, "31"),
		muted: style(color, "2"),
	};
}

function style(color: boolean, code: string): (value: string) => string {
	return (value) => (color ? `\u001b[${code}m${value}\u001b[0m` : value);
}
