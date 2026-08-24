import express = require("express");
import * as Sentry from "@sentry/node";
import * as dotenv from "dotenv";
import { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import { getEndpoint, getAllEndpoints, getEndpointByPlatform } from "./GetEndpoint";
import { validateToken } from "./TokenHandler";
import {
	removeArrayItemFromConfig,
	updateEndpointConfig,
} from "./UpdateEndpointConfig";
import { validateConfig } from "./types/ConfigKeys";
import cors = require("cors");
import { roundStatistics } from "./Statistics";
import { is_suspended } from "./SuspensionHandler";
import { distribute, updateMeta } from "./MessageHandler";
import { getDb } from "./utils/pgsql";
import "./QueueProcessor";
import { createEndpointAndToken, createNewToken } from "./CreationHandler";
import { deleteEndpointAndToken, deleteToken } from "./DeletionHandler";
import log from "./utils/logger";
import { getLogFilePath } from "./utils/logger";
import { checkEndpoint, repairEndpointStructure, dailyCheck } from "./HealthCheck";
import { health } from "./utils/health";
import path = require("path");
import { getDb as getSurrealDb } from "./utils/surrealdb";
import * as crypto from "crypto";
import { clearTemporaryAttachments } from "./AttachmentProcessor";
import { markRead } from "./ReadHandler";
import { addEmoji, removeEmoji, updateEmoji } from "./EmojiHandler";
import { RecordId, StringRecordId, jsonify } from "surrealdb";
import { migrateEndpointsFromSurrealToPostgres } from "./MigrationHandler";

dotenv.config();
const MASTER_TOKEN = process.env.MASTER_TOKEN;
const SENTRY_DSN = process.env.SENTRY_DSN;


Sentry.init({
	dsn: SENTRY_DSN,
	tracesSampleRate: 1.0,
	profilesSampleRate: 1.0,
});


const app = express();


app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
	log("API_REQUEST", `${req.method} ${req.url}`);
	health.increment("requests_total");
	next();
});

const RATE_LIMIT_PER_IP = parseInt(process.env.RATE_LIMIT_PER_IP || "10", 10);
const RATE_LIMIT_WINDOW_MS = parseInt(
	process.env.RATE_LIMIT_WINDOW_MS || "1000",
	10
);

const rateLimiterCache: { [ip: string]: number[] } = {};

const rateLimiter = (req: Request, res: Response, next: NextFunction) => {
	const ip = req.ip ?? "unknown";
	const now = Date.now();
	const windowMs = RATE_LIMIT_WINDOW_MS;
	const maxReqs = RATE_LIMIT_PER_IP;

	if (!rateLimiterCache[ip]) {
		rateLimiterCache[ip] = [];
	}
	rateLimiterCache[ip] = rateLimiterCache[ip].filter(
		(ts: number) => now - ts < windowMs
	);
	if (rateLimiterCache[ip].length >= maxReqs) {
		log(
			"WARN",
			`Rate limit exceeded for IP: ${ip} at ${new Date(
				now
			).toISOString()} with ${rateLimiterCache[ip].length} requests`
		);
		res.status(429).send({ message: "Too Many Requests", status: 429 });
		return;
	}
	rateLimiterCache[ip].push(now);
	next();
};
app.use(rateLimiter);

app.use(
	cors({
		origin: "*",
		methods: ["GET", "POST", "PATCH", "DELETE"],
		credentials: true,
	})
);

const readFile = (filePath: string): Promise<string> =>
	new Promise((resolve, reject) => {
		fs.readFile(filePath, "utf8", (err, data) => {
			if (err) reject(err);
			else resolve(data);
		});
	});

type ApiReferenceEntry = {
	method: string;
	path: string;
	params: string[];
	query: string[];
	body: string[];
};

let apiReferencesCache: ApiReferenceEntry[] = [];
let apiReferencesGeneratedAt: string | null = null;

function extractKeysFromSource(source: string, scope: "params" | "query" | "body"): Set<string> {
	const keys = new Set<string>();
	const dotRegex = new RegExp(`req\\.${scope}\\.([a-zA-Z0-9_-]+)`, "g");
	const bracketRegex = new RegExp(`req\\.${scope}\\[(?:'|\")([^'\"]+)(?:'|\")\\]`, "g");

	for (const match of source.matchAll(dotRegex)) {
		if (match[1]) keys.add(match[1]);
	}
	for (const match of source.matchAll(bracketRegex)) {
		if (match[1]) keys.add(match[1]);
	}

	return keys;
}

function extractPathParams(pathValue: string): string[] {
	const params: string[] = [];
	for (const match of pathValue.matchAll(/:([a-zA-Z0-9_]+)/g)) {
		if (match[1]) params.push(match[1]);
	}
	return [...new Set(params)];
}

function buildApiReferencesFromRouterStack(stack: any[], basePath: string = ""): ApiReferenceEntry[] {
	const entries: ApiReferenceEntry[] = [];

	for (const layer of stack) {
		if (layer.route?.path) {
			const routePath = `${basePath}${layer.route.path}`;
			const methods = Object.keys(layer.route.methods || {})
				.filter((method) => layer.route.methods[method])
				.map((method) => method.toUpperCase());

			const sourceCombined = (layer.route.stack || [])
				.map((routeLayer: any) => String(routeLayer.handle || ""))
				.join("\n");

			const inferredParams = new Set<string>(extractPathParams(routePath));
			for (const key of extractKeysFromSource(sourceCombined, "params")) {
				inferredParams.add(key);
			}

			const inferredQuery = extractKeysFromSource(sourceCombined, "query");
			const inferredBody = extractKeysFromSource(sourceCombined, "body");

			const usesReqBody = sourceCombined.includes("req.body");
			const body = Array.from(inferredBody);
			if (usesReqBody && body.length === 0) {
				body.push("<dynamic-body>");
			}

			for (const method of methods) {
				entries.push({
					method,
					path: routePath,
					params: Array.from(inferredParams),
					query: Array.from(inferredQuery),
					body,
				});
			}
			continue;
		}

		if (layer.name === "router" && layer.handle?.stack) {
			entries.push(...buildApiReferencesFromRouterStack(layer.handle.stack, basePath));
		}
	}

	return entries;
}

function rebuildApiReferences() {
	const stack = (app as any)?._router?.stack || [];
	apiReferencesCache = buildApiReferencesFromRouterStack(stack).sort((a, b) => {
		if (a.path === b.path) return a.method.localeCompare(b.method);
		return a.path.localeCompare(b.path);
	});
	apiReferencesGeneratedAt = new Date().toISOString();
}

function queryFlag(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function generateUrlSafeToken(length: number = 71): string {
	return crypto.randomBytes(53).toString("base64url").slice(0, length);
}

function removeFromArray<T>(arr: T[] | undefined, value: T): T[] {
	if (!Array.isArray(arr)) return [];
	return arr.filter((item) => item !== value);
}

function getRequestToken(req: Request): string | undefined {
	const token = req.query.token as string | undefined;
	return token;
}

async function checkEndpointToken(endpointId: bigint, token: string | undefined): Promise<boolean> {
	if (!token) return false;
	return validateToken(endpointId, token);
}

async function getAttachmentById(assetId: string): Promise<any | null> {
	const db = await getDb();
	try {
		const { rows } = await db.query("SELECT data FROM attachments WHERE id = $1", [assetId]);
		if (rows.length === 0) return null;
		return rows[0].data;
	} finally {
		db.release();
	}
}

async function overwriteEndpointJson(endpointId: bigint, body: unknown): Promise<any | null> {
	const db = await getDb();
	try {
		const result = await db.query(
			"UPDATE endpoints SET data = $2::jsonb WHERE id = $1 RETURNING data",
			[endpointId.toString(), JSON.stringify(body)]
		);
		if (result.rows.length === 0) return null;
		return result.rows[0].data;
	} finally {
		db.release();
	}
}

function getBetaTokens(): Set<string> {
	const configured = process.env.BETA_TOKENS || "";
	return new Set(
		configured
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean)
	);
}

app.get("/viewlogs", async (req: Request, res: Response) => {
	const token = req.query.token as string;
	if (token === process.env.LOG_TOKEN) {
		try {
			const html = await readFile("./web/log-console.html");
			res.type("text/html").status(200).send(html);
		} catch (err) {
			res.status(500).send("Error reading log file: " + err);
		}
	} else {
		res.status(404).send();
	}
});

app.get("/viewhealth", async (req: Request, res: Response) => {
	try {
		const htmlPath = path.join(process.cwd(), "web", "health.html");
		res.sendFile(htmlPath);
	} catch (err) {
		res.status(500).send("Error reading health page");
	}
});

app.get("/health", (req: Request, res: Response) => {
	res.status(200).json(health.getSummary());
});

app.get("/health/events", (req: Request, res: Response) => {
	const limit = Math.min(1000, parseInt(String(req.query.limit ?? "100"), 10) || 100);
	res.status(200).json(health.getRecentEvents(limit));
});

app.get("/health/stream", (req: Request, res: Response) => {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders?.();
	const snap = health.getSummary();
	res.write(`event: snapshot\n`);
	res.write(`data: ${JSON.stringify(snap)}\n\n`);
	health.addSSEClient(res);
});

app.post("/health/ping", async (req: Request, res: Response) => {
	try {
		await health.performManualPingTests();
		res.status(200).json({ 
			success: true, 
			message: "Ping tests initiated", 
			timestamp: new Date().toISOString() 
		});
	} catch (error) {
		res.status(500).json({ 
			success: false, 
			error: error instanceof Error ? error.message : 'Unknown error' 
		});
	}
});

app.get("/health/latency", (req: Request, res: Response) => {
	const history = health.getLatencyHistory();
	res.status(200).json({
		success: true,
		data: history,
		count: history.length,
		timestamp: new Date().toISOString()
	});
});
app.get("/logs", async (req: Request, res: Response) => {
	const token = req.query.token as string;
	if (token === process.env.LOG_TOKEN) {
		try {
			const logData = await readFile(getLogFilePath());
			res.type("text/plain").status(200).send(logData);
		} catch (err) {
			res.status(500).send("Error reading log file");
		}
	} else {
		res.status(404).send();
	}
});

app.get("/logs/stream", async (req: any, res: any) => {
	const token = req.query.token as string;
	if (token !== process.env.LOG_TOKEN) {
		return res.status(404).send();
	}

	const filePath = getLogFilePath();
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders?.();

	const send = (line: string) => {
		try {
			res.write(`event: log\n`);
			res.write(`data: ${JSON.stringify(line)}\n\n`);
		} catch (e) {
			// If we fail to send, the client has likely disconnected, so we stop trying to send further logs.
		}
	};

	try {
		const initial = await readFile(filePath);
		if (initial && initial.length > 0) {
			const lines = initial.split(/\r?\n/).filter(Boolean);
			for (const l of lines) send(l);
		}
	} catch (e) {
		send("[log-stream] Could not read log file initially: " + String(e));
	}

	let lastSize = 0;
	try {
		const st = await fs.promises.stat(filePath);
		lastSize = st.size;
	} catch (e) {
		lastSize = 0;
	}

	const watcher = fs.watch(filePath, async (eventType) => {
		try {
			const st = await fs.promises.stat(filePath);
			if (st.size < lastSize) {
				const full = await readFile(filePath);
				const lines = full.split(/\r?\n/).filter(Boolean);
				for (const l of lines) send(l);
				lastSize = st.size;
				return;
			}
			if (st.size > lastSize) {
				const stream = fs.createReadStream(filePath, { start: lastSize, end: st.size - 1, encoding: 'utf8' });
				let buf = '';
				stream.on('data', (chunk) => {
					buf += chunk;
					const parts = buf.split(/\r?\n/);
					buf = parts.pop() || '';
					for (const p of parts) {
						if (p.length > 0) send(p);
					}
				});
				stream.on('end', () => {
					if (buf.length > 0) send(buf);
				});
				stream.on('error', () => {});
				lastSize = st.size;
			}
		} catch (err) {
			send("[log-stream] Error while tailing: " + String(err));
		}
	});

	req.on('close', () => {
		try {
			watcher.close();
		} catch (e) {}
		try { res.end(); } catch (e) {}
	});
});

app.get("/ga-test", (req: Request, res: Response) => {
	res.status(200).json({ commited: "210824-15" });
});

app.get("/assets/:asset", async (req: Request, res: Response): Promise<any> => {
	const asset = req.params.asset;
	const width = req.query.width as string | undefined;
	const height = req.query.height as string | undefined;

	const aliases: Record<string, string> = {
		logo_no_bg: "astroid_logo.png",
		logo: "astroid_logo.png",
		banner: "astroid_logo.png",
	};

	const candidateName = aliases[asset] || asset;
	const candidates = [
		path.join(process.cwd(), "web", candidateName),
		path.join(process.cwd(), "web", "icons", candidateName),
		path.join(process.cwd(), "web", `${candidateName}.png`),
		path.join(process.cwd(), "web", "icons", `${candidateName}.png`),
	];

	for (const candidate of candidates) {
		try {
			await fs.promises.access(candidate, fs.constants.F_OK);
			if (width || height) {
				log("WARN", `Asset resize requested for '${asset}' (${width}x${height}) - serving original file`);
			}
			return res.sendFile(candidate);
		} catch {
			continue;
		}
	}

	return res.status(404).json({ message: "This asset does not exist." });
});

app.get("/docs", (req: Request, res: Response) => {
	res.redirect("https://docs.astroid.cc");
});

app.get("/invite/:platform", (req: Request, res: Response): void => {
	const platform = req.params.platform;
	const token = req.query.token as string | undefined;
	const betaTokens = getBetaTokens();

	if (platform === "discord") {
		res.redirect("https://discord.com/oauth2/authorize?client_id=1408109359430500464&permissions=2687625280&integration_type=0&scope=applications.commands+bot");
		return;
	}
	if (platform === "guilded") {
		res.redirect("https://www.guilded.gg/b/00c19caa-e176-45f6-b1f6-7bee5ba73db9");
		return;
	}
	if (platform === "nerimity") {
		res.redirect("https://nerimity.com/bot/1570083353837875200?perms=202");
		return;
	}
	if (platform === "nerimity-beta") {
		res.redirect("https://nerimity.com/bot/1528027197628129280?perms=202");
		return;
	}
	if (platform === "discord-beta" && token && betaTokens.has(token)) {
		res.redirect("https://discord.com/oauth2/authorize?client_id=1230579871059804280&permissions=138046467089&scope=applications.commands+bot");
		return;
	}
	if (platform === "guilded-beta" && token && betaTokens.has(token)) {
		res.redirect("https://www.guilded.gg/b/3f887186-82d5-4fe1-abbd-045748b125b3");
		return;
	}
	if (platform === "revolt-beta" && token && betaTokens.has(token)) {
		res.redirect("https://app.revolt.chat/bot/01HZH72H3PZKTEG1ADQ5P2XBF5");
		return;
	}

	res.status(400).json({ message: "Invalid platform." });
});

app.get("/discord", (req: Request, res: Response) => {
	res.redirect("https://discord.gg/DbrFADj6Xw");
});

app.get("/", (req: Request, res: Response) => {
	const homeData = {
		heading: "Astroid API",
		description: "Astroid API for getting and modifying endpoints.",
		website: "https://astroid.cc",
		privacy: "https://astroid.cc/privacy",
		terms: "https://astroid.cc/terms",
		imprint: "https://astroid.cc/imprint",
		docs: "https://astroid.cc/docs",
		discord: "https://discord.gg/DbrFADj6Xw",
	};
	res.status(200).json(homeData);
});

app.get("/favicon.ico", (req: Request, res: Response) => {
	const faviconPath = "./web/icons/favicon.ico";
	res.sendFile(faviconPath, { root: process.cwd() });
});

app.get("/statistics", async (req: Request, res: Response): Promise<any> => {
	try {
		const stats = await roundStatistics();
		health.record("stats", "Fetched statistics");
		res.status(200).json(stats);
	} catch (err) {
		log("ERROR", "Error fetching statistics:", err);
		res.status(500).send({ message: "Internal Server Error", status: 500 });
	}
});

app.get("/cdn/:assetId", async (req: Request, res: Response): Promise<any> => {
	const assetId = req.params.assetId;
	try {
		const asset = await getAttachmentById(assetId);
		if (!asset) {
			return res.status(404).json({ message: "This asset does not exist." });
		}

		const filePath = asset.path as string | undefined;
		if (!filePath) {
			return res.status(404).json({ message: "This asset does not exist." });
		}

		await fs.promises.access(filePath, fs.constants.F_OK);
		return res.sendFile(path.resolve(filePath));
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.get("/getserverstructure", async (req: Request, res: Response): Promise<any> => {
	const id = req.query.id as string;
	const token = req.query.token as string;
	if (!id || !token) {
		return res.status(400).json({ message: "Missing id or token." });
	}

	let endpointId: bigint;
	try {
		endpointId = BigInt(id);
	} catch {
		return res.status(400).json({ message: "Invalid id." });
	}

	const isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	if (!process.env.DISCORD_TOKEN) {
		return res.status(500).json({ message: "DISCORD_TOKEN is not configured." });
	}

	const headers = {
		Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
		"Content-Type": "application/json",
	};

	const response = await fetch(`https://discord.com/api/v9/guilds/${id}/channels`, { headers });
	if (!response.ok) {
		const body = await response.text();
		return res.status(response.status).send(body);
	}

	type DiscordChannel = {
		id: string;
		name: string;
		type: number;
		parent_id: string | null;
	};

	const responseChannels = (await response.json()) as DiscordChannel[];
	const channels: Record<string, Array<{ name: string; id: string; type: "text" | "voice" }>> = {};

	for (const channel of responseChannels) {
		if (![0, 2, 5].includes(channel.type)) continue;
		let category = "uncategorized";
		if (channel.parent_id) {
			try {
				const categoryResponse = await fetch(`https://discord.com/api/v9/channels/${channel.parent_id}`, { headers });
				if (categoryResponse.ok) {
					const categoryBody = (await categoryResponse.json()) as { name?: string };
					category = categoryBody.name || category;
				}
			} catch {
				category = "uncategorized";
			}
		}

		if (!channels[category]) {
			channels[category] = [];
		}
		channels[category].push({
			name: channel.name,
			id: channel.id,
			type: channel.type === 2 ? "voice" : "text",
		});
	}

	return res.status(200).json(channels);
});

app.get("/allendpoints", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	if (token !== MASTER_TOKEN) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}
	const endpoints = await getAllEndpoints();
	if (endpoints) {
		res.status(200).json(endpoints);
	}
});

app.post("/migrate/endpoints/surreal-to-postgres", async (req: Request, res: Response): Promise<any> => {
	const token = getRequestToken(req);
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	const body = (req.body || {}) as Record<string, unknown>;
	const dryRun = queryFlag(body.dryRun);
	const overwriteExisting = queryFlag(body.overwriteExisting);
	const migrateOutOfRangeToOverflow =
		body.migrateOutOfRangeToOverflow === undefined
			? true
			: queryFlag(body.migrateOutOfRangeToOverflow);
	const rawLimit = body.limit;
	let limit: number | undefined;
	if (typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0) {
		limit = Math.floor(rawLimit);
	}

	const summary = await migrateEndpointsFromSurrealToPostgres({
		dryRun,
		overwriteExisting,
		migrateOutOfRangeToOverflow,
		limit,
	});

	if (summary.errors > 0) {
		return res.status(500).json({
			message: "Migration finished with errors. No data was committed.",
			summary,
		});
	}

	return res.status(200).json({
		message: dryRun
			? "Dry-run completed. No data was written."
			: "Migration completed successfully.",
		summary,
	});
});

app.get(
	"/healthcheck/:id",
	async (req: Request, res: Response): Promise<any> => {
		const endpointId = BigInt(req.params.id);
		const token = req.query.token as string;
		if (!token) {
			return res
				.status(401)
				.send({ message: "Unauthorized: No token provided", status: 401 });
		}
		let isValidToken = await validateToken(endpointId, token);
		if (!isValidToken) {
			return res
				.status(401)
				.send({ message: "Unauthorized: Invalid token", status: 401 });
		}
		is_suspended(endpointId)
			.then((suspended) => {
				if (suspended) {
					return res
						.status(403)
						.send({ message: "Forbidden: Endpoint is suspended", status: 403 });
				}
			})
			.catch((err) => {});
		const endpoint = await getEndpoint(endpointId);
		if (!endpoint) {
			return res
				.status(404)
				.send({ message: "Endpoint not found", status: 404 });
		}

		const isHealthy = await checkEndpoint(endpointId);
		health.record("endpoint:healthcheck", `Health check ${endpointId.toString()} -> ${isHealthy ? "healthy" : "unhealthy"}`);
		if (isHealthy) {
			res.status(200).json({ message: "Endpoint is healthy", status: 200 });
		} else {
			res.status(500).json({ message: "Endpoint is not healthy", status: 500 });
		}
	}
);

app.patch("/daily_endpoint_check", async (req: Request, res: Response): Promise<any> => {
	const token = getRequestToken(req);
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	try {
		const summary = await dailyCheck();
		const randomToken = generateUrlSafeToken(53);
		const summariesDir = path.join(process.cwd(), "healtcheck_summaries");
		await fs.promises.mkdir(summariesDir, { recursive: true });
		const summaryPath = path.join(summariesDir, `${randomToken}.txt`);
		await fs.promises.writeFile(summaryPath, summary.join("\n"), "utf8");

		return res.status(200).json({
			message: "Success.",
			total: summary.length,
			summary: `/healtcheck_summaries/${randomToken}`,
		});
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.get("/healtcheck_summaries/:token", async (req: Request, res: Response): Promise<any> => {
	const token = req.params.token;
	const summaryPath = path.join(process.cwd(), "healtcheck_summaries", `${token}.txt`);
	try {
		const content = await readFile(summaryPath);
		return res.type("text/plain").status(200).send(content);
	} catch {
		return res.status(404).json({ message: "This summary does not exist." });
	}
});

app.post(
	"/healthcheck/:id/repair",
	async (req: Request, res: Response): Promise<any> => {
		const endpointId = BigInt(req.params.id);
		const token = req.query.token as string;
		if (!token) {
			return res
				.status(401)
				.send({ message: "Unauthorized: No token provided", status: 401 });
		}
		let isValidToken = await validateToken(endpointId, token);
		if (!isValidToken) {
			return res
				.status(401)
				.send({ message: "Unauthorized: Invalid token", status: 401 });
		}
		is_suspended(endpointId)
			.then((suspended) => {
				if (suspended) {
					return res
						.status(403)
						.send({ message: "Forbidden: Endpoint is suspended", status: 403 });
				}
			})
			.catch((err) => {});

		try {
			await repairEndpointStructure(endpointId);
			health.record("endpoint:repair", `Repair initiated for ${endpointId.toString()}`);
			res
				.status(200)
				.json({ message: "Endpoint repair initiated", status: 200 });
		} catch (err) {
			log("ERROR", `Error repairing endpoint '${endpointId}': ${err}`);
			res.status(500).send({ message: "Internal Server Error", status: 500 });
		}
	}
);

app.get("/references", (req: Request, res: Response) => {
	res.status(200).json({
		generatedAt: apiReferencesGeneratedAt,
		count: apiReferencesCache.length,
		endpoints: apiReferencesCache,
	});
});

app.get("/bridges/:id", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string;
	if (!token) {
		return res.status(401).json({ message: "You must provide a token." });
	}

	const isValidToken = await checkEndpointToken(endpointId, token);
	if (!isValidToken) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}

	const endpoint = await getEndpoint(endpointId);
	if (!endpoint) {
		return res.status(404).json({ message: "This endpoint does not exist." });
	}

	return res.status(200).json({
		discord: endpoint.config?.channels?.discord || [],
		guilded: endpoint.config?.channels?.guilded || [],
		revolt: endpoint.config?.channels?.revolt || [],
		nerimity: endpoint.config?.channels?.nerimity || [],
	});
});

app.post("/update/:id/json", async (req: Request, res: Response): Promise<any> => {
	const token = getRequestToken(req);
	if (token !== MASTER_TOKEN) {
		return res.status(404).json({ detail: "Not found" });
	}

	const endpointId = BigInt(req.params.id);
	const body = req.body;
	if (!body || typeof body !== "object") {
		return res.status(400).json({ message: "Invalid request. Missing endpoint or body." });
	}

	const updated = await overwriteEndpointJson(endpointId, body);
	if (!updated) {
		return res.status(404).json({ message: "This endpoint does not exist." });
	}
	return res.status(200).json(updated);
});

app.post("/read/:id", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string | undefined;
	const body = (req.body || {}) as Record<string, unknown>;
	if (!(await checkEndpointToken(endpointId, token))) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}

	try {
		if (queryFlag(body.read_discord ?? body.readDiscord)) await markRead(endpointId, "discord");
		if (queryFlag(body.read_guilded ?? body.readGuilded)) await markRead(endpointId, "guilded");
		if (queryFlag(body.read_revolt ?? body.readRevolt)) await markRead(endpointId, "revolt");
		if (queryFlag(body.read_nerimity ?? body.readNerimity)) await markRead(endpointId, "nerimity");
		return res.status(200).json({ message: "Success." });
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.delete("/tempattachments", async (req: Request, res: Response): Promise<any> => {
	const token = getRequestToken(req);
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	try {
		await clearTemporaryAttachments();
		return res.status(200).json({ message: "Success." });
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.delete("/delete/data/:id", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string | undefined;
	const body = (req.body || {}) as Record<string, unknown>;

	if (!(await checkEndpointToken(endpointId, token))) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}

	const endpoint = await getEndpoint(endpointId);
	if (!endpoint) {
		return res.status(404).json({ message: "This endpoint does not exist." });
	}

	const updated = JSON.parse(JSON.stringify(endpoint));

	if (body.webhook_discord) {
		updated.config.webhooks.discord = removeFromArray(updated.config.webhooks.discord, String(body.webhook_discord));
	}
	if (body.webhook_guilded) {
		updated.config.webhooks.guilded = removeFromArray(updated.config.webhooks.guilded, String(body.webhook_guilded));
	}
	if (body.webhook_revolt) {
		updated.config.webhooks.revolt = removeFromArray(updated.config.webhooks.revolt, String(body.webhook_revolt));
	}
	if (body.webhook_nerimity) {
		updated.config.webhooks.nerimity = removeFromArray(updated.config.webhooks.nerimity, String(body.webhook_nerimity));
	}

	if (queryFlag(body.log_discord)) updated.config.logs.discord = null;
	if (queryFlag(body.log_guilded)) updated.config.logs.guilded = null;
	if (queryFlag(body.log_revolt)) updated.config.logs.revolt = null;
	if (queryFlag(body.log_nerimity)) updated.config.logs.nerimity = null;

	if (body.blacklist) {
		for (const word of String(body.blacklist).split(",").map((v) => v.trim()).filter(Boolean)) {
			updated.config.blacklist = removeFromArray(updated.config.blacklist, word);
		}
	}
	if (body.allowed_ids) {
		for (const id of String(body.allowed_ids).split(",").map((v) => v.trim()).filter(Boolean)) {
			updated.config["allowed-ids"] = removeFromArray(updated.config["allowed-ids"], id);
		}
	}

	if (body.channel_discord) {
		updated.config.channels.discord = removeFromArray(updated.config.channels.discord, String(body.channel_discord));
	}
	if (body.channel_guilded) {
		updated.config.channels.guilded = removeFromArray(updated.config.channels.guilded, String(body.channel_guilded));
	}
	if (body.channel_revolt) {
		updated.config.channels.revolt = removeFromArray(updated.config.channels.revolt, String(body.channel_revolt));
	}
	if (body.channel_nerimity) {
		updated.config.channels.nerimity = removeFromArray(updated.config.channels.nerimity, String(body.channel_nerimity));
	}

	if (queryFlag(body.sender_channel)) updated.meta["sender-channel"] = null;
	if (queryFlag(body.sender)) updated.meta.sender = null;
	if (queryFlag(body.message_author_name)) updated.meta.message.author.name = null;
	if (queryFlag(body.message_author_id)) updated.meta.message.author.id = null;
	if (queryFlag(body.message_author_avatar)) updated.meta.message.author.avatar = null;
	if (queryFlag(body.message_content)) updated.meta.message.content = null;
	if (body.message_attachments) {
		updated.meta.message.attachments = removeFromArray(updated.meta.message.attachments, String(body.message_attachments));
	}

	const result = await overwriteEndpointJson(endpointId, updated);
	return res.status(200).json(result);
});

app.post("/createendpoint/:platform", async (req: Request, res: Response): Promise<any> => {
	const platform = req.params.platform;
	const token = req.query.token as string | undefined;
	const endpointRaw = String(req.body.endpoint ?? "");
	const serverId = String(req.body.id ?? "");

	if (!endpointRaw || !serverId) {
		return res.status(400).json({ message: "Missing endpoint or id." });
	}

	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid. (Only the master token can be used to view or create relations.)" });
	}

	let endpointId: bigint;
	try {
		endpointId = BigInt(endpointRaw);
	} catch {
		return res.status(400).json({ message: "Invalid endpoint id." });
	}

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}

	if (!["guilded", "revolt", "nerimity"].includes(platform)) {
		return res.status(404).json({ message: "This platform does not exist." });
	}

	const db = await getSurrealDb();
	try {
		const recordId = new StringRecordId(`${platform}_servers:⟨${serverId}⟩`);
		await db.create(recordId, { discord: Number(endpointId.toString()) }).catch(async () => {
			await db.merge(recordId, { discord: Number(endpointId.toString()) });
		});
		return res.status(200).json({ message: "Success.", endpoint: Number(endpointId.toString()), id: serverId, platform });
	} catch {
		return res.status(404).json({ message: "This endpoint does not exist." });
	}
});

app.patch("/syncserverrelations", async (req: Request, res: Response): Promise<any> => {
	const db = await getSurrealDb();
	try {
		const tables = ["guilded_servers", "revolt_servers", "nerimity_servers"];
		const deleted: Record<string, number> = { guilded_servers: 0, revolt_servers: 0, nerimity_servers: 0 };

		for (const table of tables) {
			const rows = jsonify(await db.query(`SELECT id, discord FROM ${table}`)) as any[];
			for (const row of rows || []) {
				const endpointValue = row?.discord;
				if (endpointValue === undefined || endpointValue === null) continue;
				let endpointId: bigint;
				try {
					endpointId = BigInt(String(endpointValue));
				} catch {
					await db.delete(row.id as RecordId);
					deleted[table] += 1;
					continue;
				}
				const endpoint = await getEndpoint(endpointId);
				if (!endpoint) {
					await db.delete(row.id as RecordId);
					deleted[table] += 1;
				}
			}
		}

		return res.status(200).json({ message: "Success.", deleted });
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.get("/channel/name/:platform", async (req: Request, res: Response): Promise<any> => {
	const platform = req.params.platform;
	const id = String(req.query.id ?? "");
	if (!id) {
		return res.status(400).json({ message: "Missing id." });
	}

	if (platform === "discord") {
		if (!process.env.DISCORD_TOKEN) {
			return res.status(500).json({ message: "DISCORD_TOKEN is not configured." });
		}
		try {
			const response = await fetch(`https://discord.com/api/v9/channels/${id}`, {
				headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
			});
			if (!response.ok) {
				const beta_response = await fetch(`https://discord.com/api/v10/channels/${id}`, {
					headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
				});
				if (!beta_response.ok) {
					return res.status(404).json({ message: "This channel does not exist." });
				}
				const body = (await beta_response.json()) as { name?: string };
				return res.status(200).json(body.name || null);
			}
			const body = (await response.json()) as { name?: string };
			return res.status(200).json(body.name || null);
		} catch {
			return res.status(404).json({ message: "This channel does not exist." });
		}
	}

	if (platform === "nerimity") {
		if (!process.env.NERIMITY_TOKEN) {
			return res.status(500).json({ message: "NERIMITY_TOKEN is not configured." });
		}
		try {
			const response = await fetch(`https://nerimity.com/api/channels/${id}`, {
				headers: { Authorization: `${process.env.NERIMITY_TOKEN}` },
			});
			if (!response.ok) {
				const beta_response = await fetch(`https://nerimity.com/api/channels/${id}`, {
					headers: { Authorization: `${process.env.BETA_NERIMITY_TOKEN}` },
				});
				if (!beta_response.ok) {
					return res.status(404).json({ message: "This channel does not exist." });
				}
				const body = (await beta_response.json()) as { name?: string };

				return res.status(200).json(body.name || null);
			}
			const body = (await response.json()) as { name?: string };
			return res.status(200).json(body.name || null);
		} catch (e) {
			console.error("Error fetching channel name:", e);
			return res.status(404).json({ message: "This channel does not exist." });
		}
	}

	if (platform === "revolt") {
		if (!process.env.REVOLT_TOKEN) {
			return res.status(500).json({ message: "REVOLT_TOKEN is not configured." });
		}
		try {
			const response = await fetch(`https://api.revolt.chat/channels/${id}`, {
				headers: { "X-Bot-Token": `${process.env.REVOLT_TOKEN}` },
			});
			if (!response.ok) {
				const beta_response = await fetch(`https://api.revolt.chat/channels/${id}`, {
					headers: { "X-Bot-Token": `${process.env.BETA_REVOLT_TOKEN}` },
				});
				if (!beta_response.ok) {
					return res.status(404).json({ message: "This channel does not exist." });
				}
				const body = (await beta_response.json()) as { name?: string };
				return res.status(200).json(body.name || null);
			}
			const body = (await response.json()) as { name?: string };
			return res.status(200).json(body.name || null);
		} catch {
			return res.status(404).json({ message: "This channel does not exist." });
		}
	}

	// If the platform is not recognized, return a 404 error
	return res.status(404).json({ message: "This platform does not exist." });
});

app.get("/contribution/contributors", async (req: Request, res: Response): Promise<any> => {
	const db = await getSurrealDb();
	try {
		const data = jsonify(await db.query("SELECT * FROM contributors"));
		return res.status(200).json(data);
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.get("/contribution/contributor", async (req: Request, res: Response): Promise<any> => {
	const name = req.query.name as string | undefined;
	const id = req.query.id as string | undefined;

	if (name && id) {
		return res.status(400).json({ message: "You can only provide either a name or an id." });
	}
	if (!name && !id) {
		return res.status(400).json({ message: "You must provide a name or an id." });
	}

	const db = await getSurrealDb();
	try {
		if (name) {
			const rows = jsonify(await db.query("SELECT * FROM contributors WHERE username = $name LIMIT 1", { name })) as any[];
			return res.status(200).json(rows[0] || null);
		}

		const record = await db.select(new RecordId("contributors", Number(id)));
		return res.status(200).json(jsonify(record));
	} catch (e) {
		return res.status(404).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.get("/contribution/contributor/avatar", async (req: Request, res: Response): Promise<any> => {
	const name = req.query.name as string | undefined;
	const id = req.query.id as string | undefined;

	if (name && id) {
		return res.status(400).json({ message: "You can only provide either a name or an id." });
	}
	if (!name && !id) {
		return res.status(400).json({ message: "You must provide a name or an id." });
	}

	const db = await getSurrealDb();
	try {
		if (name) {
			const rows = jsonify(await db.query("SELECT avatar FROM contributors WHERE username = $name LIMIT 1", { name })) as any[];
			return res.status(200).json(rows[0]?.avatar ?? null);
		}
		const record = jsonify(await db.select(new RecordId("contributors", Number(id)))) as any;
		return res.status(200).json(record?.avatar ?? null);
	} catch (e) {
		return res.status(404).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.post("/contribution/addcontributor/:id", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	const id = Number(req.params.id);
	const username = req.body.username as string | undefined;
	const avatar = req.body.avatar as string | undefined;

	const db = await getSurrealDb();
	try {
		const recordId = new RecordId("contributors", id);
		await db.create(recordId, { id, username, avatar }).catch(async () => {
			await db.merge(recordId, { username, avatar });
		});
		const updated = await db.select(recordId);
		return res.status(200).json(jsonify(updated));
	} catch (e) {
		return res.status(500).json({ message: `An error occurred: ${String(e)}` });
	}
});

app.patch("/emojis/:id/sync", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string | undefined;
	const platform = req.body.platform as string | undefined;

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}

	if (platform !== "discord") {
		return res.status(400).json({ message: "This platform is not supported. Only from-discord sync is supported." });
	}

	if (!(await checkEndpointToken(endpointId, token))) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	return res.status(501).json({ message: "Discord emoji sync is not implemented yet in v3." });
});

app.post("/emojis/:id/add", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string | undefined;
	const emoji = req.body;

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}
	if (!emoji || typeof emoji !== "object") {
		return res.status(400).json({
			message: "You must provide an emoji structure.",
			example: {
				discord: "<:test:1234567890>",
				guilded: "<:test:1234567890>",
				revolt: ":test:",
				nerimity: "[ce:1234567890:test]",
			},
		});
	}
	if (!(await checkEndpointToken(endpointId, token))) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}
	return res.status(200).json(await addEmoji(endpointId, emoji));
});

app.delete("/emojis/:id/delete", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string | undefined;
	const emoji = req.body;

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}
	if (!emoji || typeof emoji !== "object") {
		return res.status(400).json({
			message: "You must provide an emoji structure.",
			example: {
				discord: "<:test:1234567890>",
				guilded: "<:test:1234567890>",
				revolt: ":test:",
				nerimity: "[ce:1234567890:test]",
			},
		});
	}
	if (!(await checkEndpointToken(endpointId, token))) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}
	return res.status(200).json(await removeEmoji(endpointId, emoji));
});

app.post("/emojis/:id/update", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string | undefined;
	const emoji = req.body;

	if (await is_suspended(endpointId)) {
		return res.status(403).json({ message: "This endpoint is suspended." });
	}
	if (!emoji || typeof emoji !== "object") {
		return res.status(400).json({
			message: "You must provide an emoji structure.",
			example: {
				discord: "<:test:1234567890>",
				guilded: "<:test:1234567890>",
				revolt: ":test:",
				nerimity: "[ce:1234567890:test]",
			},
		});
	}
	if (!(await checkEndpointToken(endpointId, token))) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}
	return res.status(200).json(await updateEmoji(endpointId, emoji));
});

app.post("/optout/:userid", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	const userid = Number(req.params.userid);
	const db = await getSurrealDb();
	const record = new RecordId("optout", userid);
	await db.create(record, { optedOut: true }).catch(async () => {
		await db.merge(record, { optedOut: true });
	});
	return res.status(200).json({ optedOut: true });
});

app.post("/optin/:userid", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	const userid = Number(req.params.userid);
	const db = await getSurrealDb();
	const record = new RecordId("optout", userid);
	await db.create(record, { optedOut: false }).catch(async () => {
		await db.merge(record, { optedOut: false });
	});
	return res.status(200).json({ optedOut: false });
});

app.get("/optout/:userid", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	if (token !== MASTER_TOKEN) {
		return res.status(401).json({ message: "The provided token is invalid." });
	}

	const userid = Number(req.params.userid);
	const db = await getSurrealDb();
	const record = jsonify(await db.select(new RecordId("optout", userid))) as any;
	return res.status(200).json({ optedOut: !!record?.optedOut });
});

app.get("/:id", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	log("DEBUG", `Received request for endpoint: ${endpointId} as type: ${typeof endpointId}`);
	health.record("endpoint:get", `Fetch endpoint ${endpointId.toString()}`);

	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		health.increment("auth_failures");
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}
	is_suspended(endpointId)
		.then((suspended) => {
			if (suspended) {
				return res
					.status(403)
					.send({ message: "Forbidden: Endpoint is suspended", status: 403 });
			}
		})
		.catch((err) => {});

	getEndpoint(endpointId)
		.then((endpoint) => {
			if (endpoint) {
				res.status(200).json(endpoint);
			} else {
				res.status(404).send({ message: "Endpoint not found", status: 404 });
			}
		})

		.catch((err) => {
			log("ERROR", err);
			res.status(500).send({ message: "Internal Server Error", status: 500 });
		});
});

app.post("/:id/config", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}

	is_suspended(endpointId)
		.then((suspended) => {
			if (suspended) {
				return res
					.status(403)
					.send({ message: "Forbidden: Endpoint is suspended", status: 403 });
			}
		})
		.catch((err) => {});

	const newConfig = req.body;
	if (!newConfig) {
		return res
			.status(400)
			.send({ message: "Bad Request: No config provided", status: 400 });
	}

	const configIsValid = validateConfig(newConfig);
	if (configIsValid) {
		return res.status(400).send({
			message: "Bad Request: Invalid config",
			status: 400,
			details: configIsValid,
		});
	}

	try {
		const updatedConfig = await updateEndpointConfig(endpointId, newConfig);
		health.record("endpoint:config:update", `Updated config for ${endpointId.toString()}`);
		if (updatedConfig) {
			res.status(200).json(updatedConfig);
		} else {
			res.status(404).send({ message: "Endpoint not found", status: 404 });
		}
	} catch (err) {
		log("ERROR", "Error updating endpoint config:", err);
		res.status(500).send({ message: "Internal Server Error", status: 500 });
	}
});

app.delete("/:id/config", async (req: Request, res: Response): Promise<any> => {
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}
	is_suspended(endpointId)
		.then((suspended) => {
			if (suspended) {
				return res
					.status(403)
					.send({ message: "Forbidden: Endpoint is suspended", status: 403 });
			}
		})
		.catch((err) => {});

	const newConfig = req.body;
	log("DEBUG", `Received newConfig: ${JSON.stringify(newConfig)}`);
	if (newConfig === undefined || Object.keys(newConfig).length === 0) {
		return res
			.status(400)
			.send({ message: "Bad Request: No config provided", status: 400 });
	}

	const configIsValid = validateConfig(newConfig);
	if (configIsValid) {
		return res.status(400).send({
			message: "Bad Request: Invalid config",
			status: 400,
			details: configIsValid,
		});
	}

	try {
		const updatedConfig = await removeArrayItemFromConfig(
			endpointId,
			newConfig
		);
		health.record("endpoint:config:delete", `Updated config (delete) for ${endpointId.toString()}`);
		if (updatedConfig) {
			res.status(200).json(updatedConfig);
		} else {
			res.status(404).send({ message: "Endpoint not found", status: 404 });
		}
	} catch (err) {
		log("ERROR", "Error removing item from config:", err);
		res.status(500).send({ message: "Internal Server Error", status: 500 });
	}
});

const allowedMessageFields = [
	"attachments",
	"author",
	"content",
	"embed",
	"isReply",
	"reply",
	"sender",
	"sender-channel",
];

function validateMessageFields(obj: any): string[] {
	const errors: string[] = [];
	if (typeof obj !== "object" || obj === null) {
		errors.push("Message-Object must be an object.");
		return errors;
	}
	for (const key of Object.keys(obj)) {
		if (!allowedMessageFields.includes(key)) {
			errors.push(`Invalid key: ${key}`);
		}
	}
	if ("attachments" in obj && !Array.isArray(obj.attachments)) {
		errors.push("attachments must be an array.");
	}
	if ("author" in obj) {
		if (typeof obj.author !== "object" || obj.author === null) {
			errors.push("author must be an object.");
		} else {
			if ("avatar" in obj.author && typeof obj.author.avatar === "undefined")
				errors.push("author.avatar is missing or invalid.");
			if ("id" in obj.author && typeof obj.author.id === "undefined")
				errors.push("author.id is missing or invalid.");
			if ("name" in obj.author && typeof obj.author.name === "undefined")
				errors.push("author.name is missing or invalid.");
		}
	}
	if ("embed" in obj) {
		if (typeof obj.embed !== "object" || obj.embed === null) {
			errors.push("embed must be an object.");
		} else {
			const embedFields = [
				"description",
				"fields",
				"footer",
				"image",
				"thumbnail",
				"title",
			];
			for (const field of embedFields) {
				if (field in obj.embed && typeof obj.embed[field] === "undefined") {
					errors.push(`embed.${field} is missing or invalid.`);
				}
			}
			if ("fields" in obj.embed && !Array.isArray(obj.embed.fields)) {
				errors.push("embed.fields must be an array.");
			}
		}
	}
	if ("isReply" in obj && typeof obj.isReply !== "boolean") {
		errors.push("isReply must be a boolean.");
	}
	if ("reply" in obj) {
		if (typeof obj.reply !== "object" || obj.reply === null) {
			errors.push("reply must be an bbject.");
		} else {
			if ("author" in obj.reply && typeof obj.reply.author === "undefined")
				errors.push("reply.author is missing or invalid.");
			if ("message" in obj.reply && typeof obj.reply.message === "undefined")
				errors.push("reply.message is missing or invalid.");
		}
	}
	if (
		"sender" in obj &&
		obj.sender !== null &&
		typeof obj.sender !== "string"
	) {
		errors.push("sender must be a string.");
	}
	if (
		"sender-channel" in obj &&
		obj["sender-channel"] !== null &&
		typeof obj["sender-channel"] !== "string"
	) {
		errors.push("sender-channel must be a string.");
	}
	return errors;
}

app.post("/:id/messages", async (req: Request, res: Response): Promise<any> => {
	// TODO: Body should be validated to ensure it contains the necessary fields
	const endpointId = BigInt(req.params.id);
	const token = req.query.token as string;
	if (!token) {
		return res
			.status(401)
			.send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = await validateToken(endpointId, token);
	if (!isValidToken) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Invalid token", status: 401 });
	}

	const message = req.body;
	if (message === undefined || Object.keys(message).length === 0) {
		return res
			.status(400)
			.send({ message: "Bad Request: No message provided", status: 400 });
	}

	const validationErrors = validateMessageFields(message);
	if (validationErrors.length > 0) {
		return res.status(400).send({
			message: "Bad Request: Invalid message fields",
			status: 400,
			details: validationErrors,
		});
	}

	const endpoint = await getEndpoint(endpointId);
	if (!endpoint) {
		return res.status(404).send({ message: "Endpoint not found", status: 404 });
	}
	const db = await getDb();
	try {
		const { rows } = await db.query(
			"SELECT data->'meta'->'_message_cache' AS cache FROM endpoints WHERE id = $1",
			[endpointId]
		);
		let cache: any[] = [];
		if (rows.length > 0 && Array.isArray(rows[0].cache)) {
			cache = rows[0].cache;
		}
		cache.push(message);
		await updateMeta(endpointId, { _message_cache: cache });

		health.increment("messages_enqueued");

		return res.status(200).json({
			message: "Message added to queue",
			status: 200,
			queueLength: cache.length,
		});
	} finally {
		db.release();
	}
});

app.post("/create", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	if (token !== MASTER_TOKEN) {
		return res
			.status(401)
			.send({ message: "Unauthorized: Master token required", status: 401 });
	}
	const endpointId = BigInt(req.body.endpointId);
	if (
		req.body.endpointId === undefined ||
		req.body.endpointId === "" ||
		typeof endpointId !== "bigint"
	) {
		return res.status(400).send({ message: "Missing endpointId", status: 400 });
	}
	let result: { endpointId: bigint; token: string } | null;
	try {
		result = await createEndpointAndToken(endpointId);
		health.increment("endpoints_created");
	} catch (err) {
		log("ERROR", "Error creating endpoint:", err);
		return res
			.status(500)
			.send({ message: "Failed to create endpoint", status: 500 });
	}
	if (!result) {
		return res
			.status(500)
			.send({ message: "Failed to create endpoint", status: 500 });
	}
	if (result.token === "exists") {
		return res
			.status(409)
			.send({ message: "Endpoint already exists", status: 409 });
	}
	const safeResult = {
		...result,
		endpointId: Number(result.endpointId)
	};
	return res.status(200).json(safeResult);
});

app.post("/newtoken", async (req: Request, res: Response): Promise<any> => {
	try {
		const token = req.query.token as string;
		const endpointId = BigInt(req.body.endpointId);
		if (token !== MASTER_TOKEN) {
			return res
				.status(401)
				.send({ message: "Unauthorized: Master token required", status: 401 });
		}
		if (!req.body.endpointId) {
			return res
				.status(400)
				.send({ message: "Missing endpointId", status: 400 });
		}
		const newToken = await createNewToken(endpointId);
		health.increment("tokens_created");
		if (!newToken) {
			return res
				.status(500)
				.send({ message: "Failed to create new token", status: 500 });
		}
		return res.status(200).json({ endpointId, token: newToken });
	} catch (err) {
		log("ERROR", "Error creating new token:", err);
		return res
			.status(500)
			.send({ message: "Internal Server Error", status: 500 });
	}
});

app.get("/getendpoint/:platform", async (req: Request, res: Response): Promise<any> => {
	const platform = req.params.platform;
	const serverid = req.query.serverid as string;
	const token = req.query.token as string;
	if (!token) {
		return res.status(401).send({ message: "Unauthorized: No token provided", status: 401 });
	}
	let isValidToken = token === MASTER_TOKEN;
	if (!isValidToken) {
		health.increment("auth_failures");
		return res.status(401).send({ message: "Unauthorized: Invalid token", status: 401 });
	}
	const endpoint = await getEndpointByPlatform(platform, serverid);
	if (endpoint) {
		res.status(200).json(endpoint);
	} else {
		res.status(404).send({ message: "Endpoint not found", status: 404 });
	}
});

app.delete("/delete", async (req: Request, res: Response): Promise<any> => {
	const token = req.query.token as string;
	const endpointId = BigInt(req.body.endpointId);
	if (!req.body.endpointId) {
		return res.status(400).send({ message: "Missing endpointId", status: 400 });
	}
	if (token !== MASTER_TOKEN) {
		const valid = await validateToken(endpointId, token);
		if (!valid) {
			return res
				.status(401)
				.send({ message: "Unauthorized: Invalid token", status: 401 });
		}
	}
	const ok = await deleteEndpointAndToken(endpointId);
	if (!ok) {
		return res
			.status(500)
			.send({ message: "Failed to delete endpoint", status: 500 });
	}
	health.increment("endpoints_deleted");
	return res
		.status(200)
		.json({ message: "Endpoint and tokens deleted", endpointId });
});

app.delete(
	"/deletetoken",
	async (req: Request, res: Response): Promise<any> => {
		const token = req.query.token as string;
		const endpointId = BigInt(req.body.endpointId);
		const tokenToDelete = req.body.token;
		if (!req.body.endpointId || !tokenToDelete) {
			return res
				.status(400)
				.send({ message: "Missing endpointId or token", status: 400 });
		}
		if (token !== MASTER_TOKEN) {
			const valid = await validateToken(endpointId, token);
			if (!valid) {
				return res
					.status(401)
					.send({ message: "Unauthorized: Invalid token", status: 401 });
			}
		}
		const ok = await deleteToken(endpointId, tokenToDelete);
		if (!ok) {
			return res
				.status(500)
				.send({ message: "Failed to delete token", status: 500 });
		}
		health.increment("tokens_deleted");
		return res
			.status(200)
			.json({ message: "Token deleted", endpointId, token: tokenToDelete });
	}
);

const prideLogo = [
	"\x1b[31m $$$$$$              $$\\                         $$\\       $$\\              $$$$$$\\  $$$$$$$\\ $$$$$$\\ \x1b[0m",
	"\x1b[33m$$  __$$\\             $$ |                        \\__|      $$ |            $$  __$$\\ $$  __$$\\_$$  _|\x1b[0m",
	"\x1b[32m$$ /  $$ | $$$$$$$\\ $$$$$$\\    $$$$$$\\   $$$$$$\\  $$\\  $$$$$$$ |            $$ /  $$ |$$ |  $$ | $$ |  \x1b[0m",
	"\x1b[36m$$$$$$$$ |$$  _____|\\_$$  _|  $$  __$$\\ $$  __$$\\ $$ |$$  __$$ |            $$$$$$$$ |$$$$$$$  | $$ |  \x1b[0m",
	"\x1b[34m$$  __$$ |\\$$$$$$\\    $$ |    $$ |  \\__|$$ /  $$ |$$ |$$ /  $$ |            $$  __$$ |$$  ____/  $$ |  \x1b[0m",
	"\x1b[35m$$ |  $$ | \\____$$\\   $$ |$$\\ $$ |      $$ |  $$ |$$ |$$ |  $$ |            $$ |  $$ |$$ |       $$ |  \x1b[0m",
	"\x1b[31m$$ |  $$ |$$$$$$$  |  \\$$$$  |$$ |      \\$$$$$$  |$$ |\\$$$$$$$ |            $$ |  $$ |$$ |     $$$$$$\\ \x1b[0m",
	"\x1b[33m\\__|  \\__|\\_______/    \\____/ \\__|       \\______/ \\__| \\_______|            \\__|  \\__|\\__|     \\______|\x1b[0m",
];
console.log(prideLogo.join("\n"));


function getPortFromArgs(defaultPort: number): number {
	const argv = process.argv;
	const pIndex = argv.indexOf('-p');
	const portIndex = argv.indexOf('--port');
	if (pIndex !== -1 && argv[pIndex + 1]) {
		const port = parseInt(argv[pIndex + 1], 10);
		if (!isNaN(port)) return port;
	}
	if (portIndex !== -1 && argv[portIndex + 1]) {
		const port = parseInt(argv[portIndex + 1], 10);
		if (!isNaN(port)) return port;
	}
	return defaultPort;
}
const PORT = getPortFromArgs(9921);

console.log(
	`\x1b[32mRate limit:           	${RATE_LIMIT_PER_IP} requests per ${
		RATE_LIMIT_WINDOW_MS / 1000
	} seconds per IP\x1b[0m`
);
console.log(`\x1b[32mMaster Token:         	${MASTER_TOKEN}\x1b[0m`);
console.log(`\x1b[32mSentry DSN:           	${SENTRY_DSN}\x1b[0m`);
console.log(
	`\x1b[32mAPI Info Webhook URL: 	${process.env.API_INFO_WEBHOOK_URL}\x1b[0m`
);
console.log(`\x1b[32mLog Token:            	${process.env.LOG_TOKEN}\x1b[0m`);
console.log(`\x1b[32mLog file path:       	${getLogFilePath()}\x1b[0m\n\n`);
console.log(
	`\x1b[32mLog URL:            	http://localhost:${PORT}/viewlogs?token=${process.env.LOG_TOKEN}\x1b[0m\n\n`
);


async function checkServiceHealth() {
	try {
		const start = Date.now();
		const db = await getDb();
		await db.query("SELECT 1");
		const latency = Date.now() - start;
		db.release();
		health.updateServiceHealth("database_pg", "healthy", { latencyMs: latency });
	} catch (err) {
		health.updateServiceHealth("database_pg", "down", { error: String(err) });
	}


	try {
		const start = Date.now();
		const sdb = await getSurrealDb();
		await sdb.query("SELECT * FROM ping:ping");
		const latency = Date.now() - start;
		health.updateServiceHealth("database_surreal", "healthy", { latencyMs: latency, error: null });
	} catch (err) {
		health.updateServiceHealth("database_surreal", "down", { error: String(err) });
	}

	const summary = health.getSummary();
	const queueSize = summary.counters.messages_in_queue || 0;
	const activeEndpoints = summary.counters.active_endpoints_with_work || 0;
	if (queueSize > 100) {
		health.updateServiceHealth("queue_processor", "degraded", { metadata: { queueSize, activeEndpoints } });
	} else {
		health.updateServiceHealth("queue_processor", "healthy", { metadata: { queueSize, activeEndpoints } });
	}

	const processedCount = summary.counters.messages_processed || 0;
	const enqueuedCount = summary.counters.messages_enqueued || 0;
	if (enqueuedCount > 0 && processedCount === 0) {
		health.updateServiceHealth("message_distribution", "degraded", { metadata: { enqueuedCount, processedCount } });
	} else {
		health.updateServiceHealth("message_distribution", "healthy", { metadata: { enqueuedCount, processedCount } });
	}
}


setInterval(checkServiceHealth, 30000);
setTimeout(checkServiceHealth, 5000);

app.listen(PORT, () => {
	rebuildApiReferences();
	log("INFO", `Built API references for ${apiReferencesCache.length} route entries`);
	log("SUCCESS", `Server listening at http://localhost:${PORT}`);
	console.log(`\x1b[32mHealth URL:            \thttp://localhost:${PORT}/viewhealth\x1b[0m`);
});
