import * as discord from "discord.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import log from "./utils/logger";

const ERRORS_DIR = path.join(process.cwd(), "errors");
const EMBED_COLOR_RED = 0xed4245;

type ErrorWithCause = Error & { cause?: unknown };

// `new Error(message, { cause })` works at runtime but doesn't type-check
// under this project's ES2020 lib target, so build the cause chain manually.
export function wrapError(message: string, cause: unknown): Error {
	const err = new Error(message) as ErrorWithCause;
	err.cause = cause;
	return err;
}

function generateErrorId(): string {
	return crypto.randomBytes(6).toString("hex").toUpperCase();
}

function getRootCause(error: unknown): unknown {
	let current = error;
	let depth = 0;
	while (current instanceof Error && (current as ErrorWithCause).cause !== undefined && depth < 10) {
		current = (current as ErrorWithCause).cause;
		depth++;
	}
	return current;
}

function getShortMessage(error: unknown): string {
	const rootCause = getRootCause(error);
	if (rootCause instanceof Error) {
		return `${rootCause.name}: ${rootCause.message}`;
	}
	if (typeof rootCause === "string") return rootCause;
	try {
		return JSON.stringify(rootCause);
	} catch {
		return String(rootCause);
	}
}

function getFullTraceback(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	let depth = 0;
	while (current !== undefined && current !== null && depth < 10) {
		if (current instanceof Error) {
			parts.push(current.stack || `${current.name}: ${current.message}`);
			current = (current as ErrorWithCause).cause;
		} else {
			parts.push(typeof current === "string" ? current : JSON.stringify(current, null, 2));
			break;
		}
		depth++;
	}
	return parts.join("\n\nCaused by:\n");
}

async function storeTraceback(errorId: string, traceback: string): Promise<void> {
	await fs.promises.mkdir(ERRORS_DIR, { recursive: true });
	await fs.promises.writeFile(path.join(ERRORS_DIR, `${errorId}.txt`), traceback, "utf8");
}

export async function getErrorTraceback(errorId: string): Promise<string | null> {
	const safeId = path.basename(errorId);
	try {
		return await fs.promises.readFile(path.join(ERRORS_DIR, `${safeId}.txt`), "utf8");
	} catch {
		return null;
	}
}

async function sendErrorWebhook(
	errorId: string,
	endpointId: bigint | number | string | null,
	shortMessage: string
): Promise<void> {
	const webhookUrl = process.env.ERROR_HANDLER_WEBHOOK_URL;
	if (!webhookUrl) {
		await log("WARN", "ERROR_HANDLER_WEBHOOK_URL is not configured; skipping error webhook notification.");
		return;
	}

	const apiUrl = process.env.API_URL || "https://api.astroid.cc";
	const tracebackUrl = `${apiUrl}/errors/${errorId}?token=${process.env.MASTER_TOKEN}`;

	try {
		const webhookClient = new discord.WebhookClient({ url: webhookUrl });
		const embed = new discord.EmbedBuilder()
			.setTitle("An error occurred")
			.setColor(EMBED_COLOR_RED)
			.addFields(
				{
					name: "Endpoint",
					value: endpointId !== null && endpointId !== undefined ? `\`${endpointId}\`` : "N/A",
					inline: true,
				},
				{ name: "Error ID", value: `\`${errorId}\``, inline: true },
				{
					name: "Message",
					value: shortMessage ? (shortMessage.length > 1000 ? `${shortMessage.slice(0, 1000)}...` : shortMessage) : "Unknown error",
				},
				{ name: "Full traceback", value: `[View traceback](${tracebackUrl})` }
			)
			.setTimestamp(new Date());

		await webhookClient.send({ embeds: [embed] });
	} catch (webhookError) {
		await log("ERROR", `Failed to send error webhook for error ${errorId}`, webhookError);
	}
}

export async function reportError(
	endpointId: bigint | number | string | null | undefined,
	error: unknown
): Promise<string> {
	const errorId = generateErrorId();
	const shortMessage = getShortMessage(error);
	const traceback = getFullTraceback(error);
	const normalizedEndpointId = endpointId ?? null;

	await log("ERROR", `[${errorId}] Endpoint ${normalizedEndpointId ?? "N/A"}: ${shortMessage}`, traceback);

	await storeTraceback(errorId, traceback).catch((err) => {
		log("ERROR", `Failed to store traceback for error ${errorId}`, err);
	});

	await sendErrorWebhook(errorId, normalizedEndpointId, shortMessage);

	return errorId;
}

export function expressErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
	const endpointId = typeof req.params?.id === "string" ? req.params.id : null;

	reportError(endpointId, err)
		.then((errorId) => {
			if (res.headersSent) return;
			res.status(500).json({ message: "Internal Server Error", status: 500, errorId });
		})
		.catch(() => {
			if (!res.headersSent) {
				res.status(500).json({ message: "Internal Server Error", status: 500 });
			}
		});
}
