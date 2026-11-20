import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import log from "./logger";

// Logs every outgoing HTTP request (axios + global fetch) on level REQ_DEBUG,
// except requests to astroid itself and to the databases.

const MAX_BODY_LENGTH = 2000;
const SENSITIVE_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-key", "x-session-token", "x-bot-token"];

function hostOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function getIgnoredHosts(): string[] {
	const hosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
	for (const url of [process.env.API_URL, process.env.DB_URL, process.env.TOKEN_DB_URL]) {
		const host = hostOf(url);
		if (host) hosts.push(host);
	}
	if (process.env.POSTGRES_HOST) hosts.push(process.env.POSTGRES_HOST.toLowerCase());
	return hosts;
}

function isIgnored(url: string): boolean {
	const host = hostOf(url);
	if (!host) return false;
	if (host === "astroid.cc" || host.endsWith(".astroid.cc")) return true;
	return getIgnoredHosts().includes(host);
}

function redactHeaders(headers: Record<string, any> | undefined): Record<string, any> {
	const result: Record<string, any> = {};
	if (!headers) return result;
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined || typeof value === "function") continue;
		result[key] = SENSITIVE_HEADERS.includes(key.toLowerCase()) ? "[REDACTED]" : value;
	}
	return result;
}

function redactUrl(url: string): string {
	return url.replace(/([?&](?:token|key|secret)=)[^&]*/gi, "$1[REDACTED]");
}

function truncate(text: string): string {
	return text.length > MAX_BODY_LENGTH
		? `${text.slice(0, MAX_BODY_LENGTH)}... [truncated, ${text.length} chars total]`
		: text;
}

function describeBody(body: any): string {
	if (body === undefined || body === null) return "<empty>";
	if (typeof body === "string") return truncate(body);
	if (Buffer.isBuffer(body)) return `<binary, ${body.length} bytes>`;
	if (body instanceof ArrayBuffer) return `<binary, ${body.byteLength} bytes>`;
	if (typeof body.pipe === "function") return "<stream>";
	if (typeof FormData !== "undefined" && body instanceof FormData) return "<form-data>";
	if (body instanceof URLSearchParams) return truncate(body.toString());
	try {
		return truncate(JSON.stringify(body));
	} catch {
		return `<${body.constructor?.name ?? typeof body}>`;
	}
}

function headersToObject(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

function isTextContentType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	return /json|text|xml|x-www-form-urlencoded/i.test(contentType);
}

function formatEntry(entry: {
	method: string;
	url: string;
	durationMs: number;
	requestHeaders: Record<string, any>;
	requestBody: string;
	status?: number;
	statusText?: string;
	responseHeaders?: Record<string, any>;
	responseBody?: string;
	error?: string;
}): string {
	const lines = [
		`${entry.method} ${redactUrl(entry.url)} -> ${entry.status ?? "NO RESPONSE"} ${entry.statusText ?? ""} (${entry.durationMs}ms)`.trim(),
		`  Request headers:  ${JSON.stringify(entry.requestHeaders)}`,
		`  Request body:     ${entry.requestBody}`,
	];
	if (entry.responseHeaders) lines.push(`  Response headers: ${JSON.stringify(entry.responseHeaders)}`);
	if (entry.responseBody !== undefined) lines.push(`  Response body:    ${entry.responseBody}`);
	if (entry.error) lines.push(`  Error:            ${entry.error}`);
	return lines.join("\n");
}

// ---------- axios ----------

type TimedConfig = InternalAxiosRequestConfig & { _reqLogStart?: number };

function axiosUrl(config: InternalAxiosRequestConfig): string {
	try {
		return axios.getUri(config);
	} catch {
		return config.url ?? "<unknown>";
	}
}

function logAxios(config: TimedConfig, response?: AxiosResponse, error?: AxiosError) {
	const url = axiosUrl(config);
	if (isIgnored(url)) return;
	log("REQ_DEBUG", formatEntry({
		method: (config.method ?? "get").toUpperCase(),
		url,
		durationMs: Date.now() - (config._reqLogStart ?? Date.now()),
		requestHeaders: redactHeaders(config.headers?.toJSON?.() ?? (config.headers as any)),
		requestBody: describeBody(config.data),
		status: response?.status,
		statusText: response?.statusText,
		responseHeaders: response ? redactHeaders(response.headers as any) : undefined,
		responseBody: response ? describeBody(response.data) : undefined,
		error: error ?`${error.code ?? ""} ${error.message}`.trim() : undefined,
	}));
}

function installAxiosLogger() {
	axios.interceptors.request.use((config: TimedConfig) => {
		config._reqLogStart = Date.now();
		return config;
	});
	axios.interceptors.response.use(
		(response) => {
			logAxios(response.config as TimedConfig, response);
			return response;
		},
		(error: AxiosError) => {
			if (error.config) logAxios(error.config as TimedConfig, error.response, error);
			return Promise.reject(error);
		}
	);
}

// ---------- fetch ----------

function installFetchLogger() {
	if (typeof globalThis.fetch !== "function") return;
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async function loggedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (isIgnored(url)) return originalFetch(input, init);

		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const requestHeaders = redactHeaders(
			headersToObject(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)))
		);
		const requestBody = describeBody(init?.body);
		const start = Date.now();

		try {
			const response = await originalFetch(input, init);
			const contentType = response.headers.get("content-type");
			let responseBody: string;
			if (isTextContentType(contentType)) {
				try {
					responseBody = truncate(await response.clone().text());
				} catch (e) {
					responseBody = `<unreadable: ${(e as Error).message}>`;
				}
			} else {
				const length = response.headers.get("content-length");
				responseBody = `<${contentType ?? "unknown type"}${length ? `, ${length} bytes` : ""}>`;
			}
			log("REQ_DEBUG", formatEntry({
				method,
				url,
				durationMs: Date.now() - start,
				requestHeaders,
				requestBody,
				status: response.status,
				statusText: response.statusText,
				responseHeaders: redactHeaders(headersToObject(response.headers)),
				responseBody,
			}));
			return response;
		} catch (e) {
			log("REQ_DEBUG", formatEntry({
				method,
				url,
				durationMs: Date.now() - start,
				requestHeaders,
				requestBody,
				error: (e as Error).message,
			}));
			throw e;
		}
	} as typeof fetch;
}

let installed = false;

export function installRequestLogger() {
	if (installed) return;
	installed = true;
	installAxiosLogger();
	installFetchLogger();
}
