/** Orders names by UTF-16 code units, the same everywhere, unlike locale-aware comparison. */
export function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
