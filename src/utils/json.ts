/**
 * Lossless JSON helpers for snowflake-style ids.
 *
 * Discord/Nerimity ids and endpoint ids are 64-bit integers. JavaScript numbers
 * only hold integers exactly up to 2^53, so `JSON.parse('{"id": 1045439291234459688}')`
 * silently rounds the id (to 1045439291234459600). These helpers keep such
 * integers as strings instead.
 */

// Matches either a complete JSON string literal (skipped as-is) or an integer
// token with 16+ digits that is not part of a decimal/exponent number.
const BIG_INT_TOKEN = /"(?:[^"\\]|\\.)*"|(?<![\d.eE+-])(-?\d{16,})(?![\d.eE])/g;

/**
 * JSON.parse that returns integers outside Number's safe range as strings
 * (e.g. "1045439291234459688") instead of rounding them. Everything else is
 * parsed exactly like JSON.parse.
 */
export function parseJsonSafe(text: string): any {
	const quoted = text.replace(BIG_INT_TOKEN, (match, bigInt: string | undefined) => {
		if (bigInt === undefined) return match; // a string literal: leave untouched
		return Number.isSafeInteger(Number(bigInt)) ? bigInt : `"${bigInt}"`;
	});
	return JSON.parse(quoted);
}

/**
 * Parses a path/query id (e.g. a Discord user id) into an exact BigInt.
 * Returns null for anything that is not a plain non-negative integer.
 */
export function parseId(value: unknown): bigint | null {
	const text = String(value ?? "").trim();
	return /^\d{1,20}$/.test(text) ? BigInt(text) : null;
}
