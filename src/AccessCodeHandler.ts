import * as crypto from "crypto";
import log from "./utils/logger";

/**
 * Access-code login for the OrbitHub dashboard.
 *
 * Flow:
 *   1. A bot (master token) requests a short one-time access code for an endpoint
 *      via a chat command (e.g. /dashboard on Discord).
 *   2. The user enters the code on the dashboard, which redeems it for a
 *      dashboard session token bound to that endpoint.
 *   3. The session token is accepted by validateToken() like a regular endpoint
 *      token until it expires or is revoked (logout).
 *
 * Codes and sessions are kept in memory on purpose: codes live for minutes and
 * sessions are cheap to re-create (run the command again). An API restart
 * simply logs dashboard users out.
 */

// No 0/O/1/I/L to avoid confusion when typing the code by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8; // 31^8 ≈ 8.5e11 combinations
const SESSION_PREFIX = "dash_";

const CODE_TTL_MS = parseInt(process.env.ACCESS_CODE_TTL_MS || String(5 * 60 * 1000), 10);
const SESSION_TTL_MS = parseInt(
	process.env.DASHBOARD_SESSION_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
	10
);
const MAX_FAILED_ATTEMPTS = parseInt(process.env.ACCESS_CODE_MAX_FAILURES || "10", 10);
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface AccessCode {
	endpointId: bigint;
	expiresAt: number;
}

interface DashboardSession {
	endpointId: bigint;
	expiresAt: number;
}

const accessCodes = new Map<string, AccessCode>();
const sessions = new Map<string, DashboardSession>();
const failedAttempts = new Map<string, number[]>();

function generateCode(): string {
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i++) {
		code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
	}
	return code;
}

/** Accepts "abcd-efgh", "ABCD EFGH", "abcdefgh" etc. */
export function normalizeCode(input: string): string {
	return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Creates a new access code for an endpoint. Any older unused code for the same
 * endpoint is invalidated so only the latest one works.
 */
export function createAccessCode(endpointId: bigint): { code: string; expiresAt: number } {
	for (const [code, entry] of accessCodes) {
		if (entry.endpointId === endpointId) accessCodes.delete(code);
	}
	let code = generateCode();
	while (accessCodes.has(code)) code = generateCode();
	const expiresAt = Date.now() + CODE_TTL_MS;
	accessCodes.set(code, { endpointId, expiresAt });
	log("INFO", `Created dashboard access code for endpoint ${endpointId}`);
	return { code: formatCode(code), expiresAt };
}

export function isLoginBlocked(ip: string): boolean {
	const now = Date.now();
	const attempts = (failedAttempts.get(ip) || []).filter((ts) => now - ts < FAILED_ATTEMPT_WINDOW_MS);
	if (attempts.length === 0) failedAttempts.delete(ip);
	else failedAttempts.set(ip, attempts);
	return attempts.length >= MAX_FAILED_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
	const attempts = failedAttempts.get(ip) || [];
	attempts.push(Date.now());
	failedAttempts.set(ip, attempts);
}

/**
 * Redeems a one-time access code. Returns a session token for the endpoint,
 * or null if the code is unknown/expired.
 */
export function redeemAccessCode(
	rawCode: string,
	ip: string
): { endpointId: bigint; token: string; expiresAt: number } | null {
	const code = normalizeCode(rawCode);
	const entry = accessCodes.get(code);
	if (!entry || entry.expiresAt < Date.now()) {
		if (entry) accessCodes.delete(code);
		recordFailedAttempt(ip);
		return null;
	}
	accessCodes.delete(code); // single use
	failedAttempts.delete(ip);

	const token = SESSION_PREFIX + crypto.randomBytes(48).toString("base64url");
	const expiresAt = Date.now() + SESSION_TTL_MS;
	sessions.set(token, { endpointId: entry.endpointId, expiresAt });
	log("INFO", `Dashboard session created for endpoint ${entry.endpointId}`);
	return { endpointId: entry.endpointId, token, expiresAt };
}

export function isDashboardSessionToken(token: string): boolean {
	return token.startsWith(SESSION_PREFIX);
}

/** True if the token is a live dashboard session for this endpoint. */
export function validateDashboardSession(endpointId: bigint, token: string): boolean {
	const session = sessions.get(token);
	if (!session) return false;
	if (session.expiresAt < Date.now()) {
		sessions.delete(token);
		return false;
	}
	return session.endpointId === endpointId;
}

export function revokeDashboardSession(token: string): boolean {
	return sessions.delete(token);
}

/** Revokes every dashboard session of an endpoint (e.g. when it is deleted). */
export function revokeEndpointSessions(endpointId: bigint): void {
	for (const [token, session] of sessions) {
		if (session.endpointId === endpointId) sessions.delete(token);
	}
}

function cleanupExpired(): void {
	const now = Date.now();
	for (const [code, entry] of accessCodes) if (entry.expiresAt < now) accessCodes.delete(code);
	for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
	for (const [ip, attempts] of failedAttempts) {
		const recent = attempts.filter((ts) => now - ts < FAILED_ATTEMPT_WINDOW_MS);
		if (recent.length === 0) failedAttempts.delete(ip);
		else failedAttempts.set(ip, recent);
	}
}

setInterval(cleanupExpired, 60 * 1000).unref();
