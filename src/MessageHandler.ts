import axios from "axios";
import * as discord from "discord.js";
import { AttachmentBuilder } from "discord.js";
import * as fs from "fs";
import * as path from "path";
import * as guilded from "guilded.js";
var FormData = require("form-data");
import {
	downloadAttachment,
	clearTemporaryAttachments,
} from "./AttachmentProcessor";
import { Attachment } from "./types/Attachment";
import { markRead, checkRead } from "./ReadHandler";
import { convertMessage } from "./EmojiHandler";
import * as dotenv from "dotenv";
import { Endpoint } from "./types/Endpoint";
import { getDb } from "./utils/pgsql";
import log from "./utils/logger";
import { response } from "express";
import { reportError, wrapError } from "./ErrorHandler";

dotenv.config();

type UpdatedJson = Endpoint;

type SendTask = {
	platform: string;
	run: () => Promise<boolean>;
};

var formdata = new FormData();

function formatSendError(error: any): string {
	if (axios.isAxiosError(error)) {
		const status = error.response?.status;
		const statusText = error.response?.statusText;
		const data = error.response?.data;
		const dataText = data !== undefined ? JSON.stringify(data) : "no response body";
		return [
			`AxiosError: ${error.message}`,
			status ? `status=${status}` : "status=unknown",
			statusText ? `statusText=${statusText}` : "statusText=unknown",
			`response=${dataText}`,
			error.stack ? `stack=${error.stack}` : "",
		]
			.filter(Boolean)
			.join(" | ");
	}

	if (error instanceof Error) {
		return error.stack
			? `${error.message} | stack=${error.stack}`
			: error.message;
	}

	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

async function executeSendTasksInParallel(
	tasks: SendTask[],
	endpoint: bigint
): Promise<boolean> {
	if (tasks.length === 0) return true;

	const settled = await Promise.allSettled(tasks.map((task) => task.run()));
	let hadSuccess = false;

	for (let i = 0; i < settled.length; i++) {
		const result = settled[i];
		const platform = tasks[i].platform;

		if (result.status === "fulfilled") {
			if (result.value) {
				hadSuccess = true;
			} else {
				const stack = new Error(
					`Send handler for ${platform} returned false without throwing`
				).stack;
				log(
					"ERROR",
					`Sending to ${platform} failed.`,
					stack ?? "no stack available"
				);
			}
		} else {
			// A thrown rejection carries a real error object (unlike the
			// fulfilled-false case above), so this is the single reliable
			// point to notify admins - report it here rather than at each
			// individual send_to_* call site to avoid duplicate webhooks.
			await reportError(endpoint, wrapError(`Sending to ${platform} failed`, result.reason));
		}
	}

	return hadSuccess;
}

export async function updateMeta(
	endpoint: bigint,
	meta_data: Record<string, any>
): Promise<Endpoint | undefined> {
	const db = await getDb();
	if (!db) {
		await reportError(endpoint, new Error("Database not initialized"));
		return undefined;
	}
	try {
		const { rows } = await db.query(
			"SELECT data->'meta' AS meta FROM endpoints WHERE id = $1",
			[endpoint.toString()]
		);
		if (rows.length === 0) {
			log("ERROR", `Endpoint '${endpoint}' not found`);
			return undefined;
		}
		let currentMeta = rows[0].meta;
		if (typeof currentMeta === "string") {
			try {
				currentMeta = JSON.parse(currentMeta);
			} catch (e) {
				await reportError(endpoint, wrapError("Failed to parse current meta as JSON", e));
				return undefined;
			}
		}
		const updatedMeta = {
			...currentMeta,
			...meta_data,
		};
		await db.query(
			"UPDATE endpoints SET data = jsonb_set(data, '{meta}', $2::jsonb) WHERE id = $1",
			[endpoint.toString(), JSON.stringify(updatedMeta)]
		);
		const result = await db.query("SELECT data FROM endpoints WHERE id = $1", [
			endpoint.toString(),
		]);
		return result.rows[0].data as Endpoint;
	} catch (err) {
		await reportError(endpoint, wrapError("Failed to update meta", err));
		return undefined;
	} finally {
		db.release();
	}
}
export async function distribute(
	endpoint: bigint,
	updated_json: UpdatedJson
): Promise<boolean> {
	updated_json = JSON.parse(JSON.stringify(updated_json));
	log("DEBUG", JSON.stringify(updated_json));
	log("DEBUG", "Distributing message to all platforms");
	try {
		const sender = updated_json.meta.message
			.sender as keyof typeof updated_json.meta.read;
		const registered_platforms = Object.keys(
			updated_json.config.channels
		).filter(
			(platform) =>
				Array.isArray(updated_json.config.channels[platform]) &&
				updated_json.config.channels[platform]?.length > 0
		);
		updated_json.meta.read[sender] = true;

		let attachments: Attachment[] | null = null;
		if (updated_json.meta.message.attachments?.length > 0) {
			attachments = [];
			for (const attachment of updated_json.meta.message.attachments) {
				try {
					const file = await downloadAttachment(
						attachment,
						registered_platforms
					);
					if (file) {
						attachments.push(file);
					} else {
						log("WARN", `Attachment ${attachment} not found.`);
					}
				} catch (e) {
					throw wrapError(`Failed to download attachment ${attachment}`, e);
				}
			}
		}
		log("DEBUG", "Sending message to all platforms");
		let sendResults: Record<string, boolean> = {};
		if (updated_json.meta.message.sender == "discord") {
			try {
				sendResults.discord = await send_from_discord(
					updated_json,
					endpoint,
					attachments
				);
			} catch (e) {
				await reportError(endpoint, wrapError("Failed to send from Discord", e));
				sendResults.discord = true;
			}
		}
		if (updated_json.meta.message.sender == "guilded") {
			try {
				sendResults.guilded = await send_from_guilded(
					updated_json,
					endpoint,
					attachments
				);
			} catch (e) {
				await reportError(endpoint, wrapError("Failed to send from Guilded", e));
				sendResults.guilded = true;
			}
		}
		if (updated_json.meta.message.sender == "nerimity") {
			try {
				sendResults.nerimity = await send_from_nerimity(
					updated_json,
					endpoint,
					attachments
				);
			} catch (e) {
				await reportError(endpoint, wrapError("Failed to send from Nerimity", e));
				sendResults.nerimity = true;
			}
		}
		if (updated_json.meta.message.sender == "revolt") {
			try {
				sendResults.revolt = await send_from_revolt(
					updated_json,
					endpoint,
					attachments
				);
			} catch (e) {
				await reportError(endpoint, wrapError("Failed to send from Revolt", e));
				sendResults.revolt = true;
			}
		}
		for (const [platform, result] of Object.entries(sendResults)) {
			if (!result) log("ERROR", `Sending to ${platform} failed.`);
		}
		let db = await getDb();
		if (!db) {
			await reportError(endpoint, new Error("Database not initialized"));
			return false;
		}
		try {
			const resetRead = {
				discord: false,
				guilded: false,
				nerimity: false,
				revolt: false,
			};
			await db.query(
				"UPDATE endpoints SET data = jsonb_set(data, '{meta,read}', $2::jsonb) WHERE id = $1",
				[endpoint.toString(), JSON.stringify(resetRead)]
			);
			updated_json.meta.message = {
				attachments: [],
				author: {
					avatar: null,
					id: null,
					name: null,
				},
				content: null,
				embed: {
					description: "None",
					fields: [],
					footer: "None",
					image: "None",
					thumbnail: "None",
					title: "None",
				},
				isReply: false,
				reply: {
					author: null,
					message: null,
				},
				sender: null,
				"sender-channel": null,
			};
			await db.query(
				"UPDATE endpoints SET data = jsonb_set(data, '{meta,message}', $2::jsonb) WHERE id = $1",
				[endpoint.toString(), JSON.stringify(updated_json.meta.message)]
			);
			return true;
		} catch (e) {
			await reportError(endpoint, wrapError("Failed to update endpoint data", e));
		} finally {
			db.release();
		}
	} catch (e) {
		await reportError(endpoint, wrapError("Failed to distribute message", e));
		return false;
	}
	return false;
}

export async function send_from_discord(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	log("DEBUG", "Sending message from Discord");
	const tasks: SendTask[] = [
		{
			platform: "guilded",
			run: () => send_to_guilded(updated_json, endpoint, attachments),
		},
		{
			platform: "nerimity",
			run: () => send_to_nerimity(updated_json, endpoint, attachments),
		},
	];

	if (updated_json.config.isbeta === true) {
		log("DEBUG", "Scheduling send_to_revolt from Discord (beta mode)");
		tasks.push({
			platform: "revolt",
			run: () => send_to_revolt(updated_json, endpoint, attachments),
		});
	} else {
		log("DEBUG", "Skipping send_to_revolt from Discord (isbeta=false)");
	}

	return executeSendTasksInParallel(tasks, endpoint);
}

export async function send_from_nerimity(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	const tasks: SendTask[] = [
		{
			platform: "discord",
			run: () => send_to_discord(updated_json, endpoint, attachments),
		},
		{
			platform: "guilded",
			run: () => send_to_guilded(updated_json, endpoint, attachments),
		},
	];

	if (updated_json.config.isbeta === true) {
		log("DEBUG", "Scheduling send_to_revolt from Nerimity (beta mode)");
		tasks.push({
			platform: "revolt",
			run: () => send_to_revolt(updated_json, endpoint, attachments),
		});
	} else {
		log("DEBUG", "Skipping send_to_revolt from Nerimity (isbeta=false)");
	}

	return executeSendTasksInParallel(tasks, endpoint);
}

export async function send_from_revolt(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	log(
		"DEBUG",
		"Source is Revolt; not sending back to Revolt to avoid loop"
	);
	const tasks: SendTask[] = [
		{
			platform: "discord",
			run: () => send_to_discord(updated_json, endpoint, attachments),
		},
	];

	if (updated_json.config.isbeta === true) {
		tasks.push(
			{
				platform: "guilded",
				run: () => send_to_guilded(updated_json, endpoint, attachments),
			},
			{
				platform: "nerimity",
				run: () => send_to_nerimity(updated_json, endpoint, attachments),
			}
		);
	}

	return executeSendTasksInParallel(tasks, endpoint);
}

export async function send_from_guilded(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	return true;
}

export async function send_to_discord(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	if (updated_json.config.channels.discord.length === 0) return true;
	try {
		const read_discord = await checkRead(endpoint, "discord");
		log("DEBUG", `Discord read status: ${read_discord}`);
		if (!read_discord) {
			let webhook: string;
			try {
				let senderChannel: string;
				senderChannel = updated_json.meta.message["sender-channel"] ?? "";
				if (senderChannel === "") {
					log(
						"ERROR",
						`No sender channel found in message: ${JSON.stringify(
							updated_json.meta.message
						)}`
					);
					return true;
				}
				if (updated_json.config.channels.guilded.includes(senderChannel)) {
					webhook =
						updated_json.config.webhooks.discord[
						updated_json.config.channels.guilded.indexOf(senderChannel)
						];
				} else if (
					updated_json.config.channels.nerimity.includes(senderChannel)
				) {
					webhook =
						updated_json.config.webhooks.discord[
						updated_json.config.channels.nerimity.indexOf(senderChannel)
						];
				} else if (
					updated_json.config.channels.revolt.includes(senderChannel)
				) {
					webhook =
						updated_json.config.webhooks.discord[
						updated_json.config.channels.revolt.indexOf(senderChannel)
						];
				} else {
					log(
						"ERROR",
						`The channel ${senderChannel} (${updated_json.meta.message.sender}) does not seem to be a registered channel on other platforms.`
					);
					return true;
				}
			} catch {
				return true;
			}
			const nextcord_files: any[] = [];
			if (attachments) {
				for (const attachment of attachments) {
					const filePath = path.resolve(attachment.path);
					if (!fs.existsSync(filePath))
						throw new Error(`Attachment file not found: ${attachment.path}`);
					let attachmentData: Buffer;
					try {
						attachmentData = fs.readFileSync(filePath);
					} catch (err) {
						throw wrapError(
							`Failed to read attachment file: ${attachment.name}`,
							err
						);
					}
					const file = new AttachmentBuilder(attachmentData, {
						name: attachment.name,
					});
					nextcord_files.push(file);
				}
			}
			updated_json.meta.message.content = await convertMessage(
				updated_json.meta.message.content,
				updated_json.meta.message.sender ?? "",
				"discord",
				endpoint
			);
			let webhookClient: discord.WebhookClient;
			if (updated_json.config.isbeta) {
				webhookClient = new discord.WebhookClient({
					url: webhook,
					token: process.env.BETA_DISCORD_TOKEN,
				});
			} else {
				webhookClient = new discord.WebhookClient({
					url: webhook,
					token: process.env.DISCORD_TOKEN,
				});
			}
			let message_content = updated_json.meta.message.content;
			if (
				message_content === null ||
				message_content === "" ||
				message_content === " "
			) {
				if (
					updated_json.meta.message.attachments &&
					updated_json.meta.message.attachments.length > 0
				) {
					message_content = "\u200e ";
				}
			}
			if (updated_json.meta.message.isReply === true) {
				const reply_emoji_filtered = await convertMessage(
					updated_json.meta.message.reply.message,
					updated_json.meta.message.sender ?? "",
					"discord",
					endpoint
				);
				message_content = `> **${updated_json.meta.message.reply.author}**\n> ${reply_emoji_filtered}\n\n${message_content}`;
			}
			let response = await webhookClient.send({
				content: message_content,
				avatarURL: updated_json.meta.message.author.avatar,
				username: updated_json.meta.message.author.name,
				files: nextcord_files,
			});
			for (const file of nextcord_files) {
				if (typeof file.destroy === "function") {
					file.destroy();
				}
			}
			await markRead(endpoint, "discord");
			log("INFO", "Sent to discord");
			if (response.id) {
				return true;
			} else {
				await reportError(endpoint, new Error("Failed to send message to Discord: No response ID"));
				return false;
			}
		} else {
			return false;
		}
	} catch (e) {
		throw wrapError("Failed to send to Discord", e);
	}
}

export async function send_to_guilded(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	return true;
}

export async function send_to_nerimity(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	log("DEBUG", "Sending to nerimity");
	if (updated_json.config.channels.nerimity.length === 0) return true;
	try {
		const read_nerimity = await checkRead(endpoint, "nerimity");
		if (!read_nerimity) {
			const response_json = updated_json;
			let sender_channel = response_json.meta.message["sender-channel"] ?? "";
			const discord_channels = response_json.config.channels.discord;
			let channel_id: string | null = null;
			let webhook_url: string | null = null;
			try {
				if (sender_channel === "") {
					log(
						"ERROR",
						`No sender channel found in message: ${JSON.stringify(
							response_json.meta.message
						)}`
					);
					return true;
				}
				if (discord_channels.includes(sender_channel)) {
					channel_id =
						response_json.config.channels.nerimity[
						discord_channels.indexOf(sender_channel)
						];
				} else if (
					response_json.config.channels.guilded.includes(sender_channel)
				) {
					channel_id =
						response_json.config.channels.nerimity[
						response_json.config.channels.guilded.indexOf(sender_channel)
						];
				} else if (
					response_json.config.channels.revolt.includes(sender_channel)
				) {
					channel_id =
						response_json.config.channels.nerimity[
						response_json.config.channels.revolt.indexOf(sender_channel)
						];
				} else {
					throw new Error(
						`The channel ${sender_channel} (${updated_json.meta.message.sender}) does not seem to be a registered channel on other platforms.`
					);
				}
				if (
					updated_json.config.isbeta === true &&
					response_json.config.webhooks.nerimity.length > 0
				) {
					const index = response_json.config.channels.nerimity.indexOf(
						channel_id
					);
					if (index >= 0) {
						const candidate = response_json.config.webhooks.nerimity[index];
						if (candidate && candidate.startsWith("http")) {
							webhook_url = candidate;
						}
					}
				}
			} catch {
				return true;
			}
			const message_author_name = response_json.meta.message.author.name;
			const original_message_content = response_json.meta.message.content ?? "";
			let message_content =
				(await convertMessage(
					original_message_content,
					updated_json.meta.message.sender ?? "",
					"nerimity",
					endpoint
				)) ?? original_message_content;
			if (message_content.trim() === "" && original_message_content.trim() !== "") {
				message_content = original_message_content;
			}

			const authToken = updated_json.config.isbeta
				? process.env.BETA_NERIMITY_TOKEN
				: process.env.NERIMITY_TOKEN;
			const headers = authToken ? { Authorization: authToken } : {};
			if (webhook_url) {
				log("DEBUG", `Sending to nerimity via webhook: ${webhook_url}`);
			} else {
				log("DEBUG", `Sending to nerimity via API channel: ${channel_id}`);
			}
			let payload: any;
			if (webhook_url) {
				const webhook_content =
					(await convertMessage(
						response_json.meta.message.content ?? "",
						updated_json.meta.message.sender ?? "",
						"nerimity",
						endpoint
					)) ?? response_json.meta.message.content ?? "";
				payload = {
					"content": webhook_content,
					"username": response_json.meta.message.author.name,
					"avatarUrl": response_json.meta.message.author.avatar,
				}
				if (response_json.meta.message.isReply) {
					const reply_emoji_filtered = await convertMessage(
						updated_json.meta.message.reply.message,
						updated_json.meta.message.sender ?? "",
						"nerimity",
						endpoint
					);
					payload.content = `> **${updated_json.meta.message.reply.author}**: ${reply_emoji_filtered}\n\n**${message_author_name}**: ${message_content}`;
				}
			} else {
				payload = {
					content: `**${message_author_name}**: ${message_content}`,
				};

				if (updated_json.meta.message.isReply) {
					const reply_emoji_filtered = await convertMessage(
						updated_json.meta.message.reply.message,
						updated_json.meta.message.sender ?? "",
						"nerimity",
						endpoint
					);
					payload.content = `> **${updated_json.meta.message.reply.author}**: ${reply_emoji_filtered}\n\n**${message_author_name}**: ${message_content}`;
				}
			}

			let nerimityCdnFileId: string | null = null;
			if (attachments && attachments.length > 0) {
				try {
					if (
						attachments[0].name.includes("../") ||
						attachments[0].name.includes("..\\")
					) {
						throw new Error("Invalid file path");
					} else {
						const filePath = path.resolve(attachments[0].path);
						const uploadFormData = new FormData();
						uploadFormData.append("f", fs.createReadStream(filePath), {
							filename: path.basename(attachments[0].name),
							contentType: attachments[0].type,
						});

						try {
							const uploadResponse = await axios.post(
								"https://cdn.nerimity.com/upload",
								uploadFormData,
								{ headers: { ...uploadFormData.getHeaders(), ...headers } }
							);
							if (uploadResponse.status === 200 && uploadResponse.data.fileId) {
								nerimityCdnFileId = uploadResponse.data.fileId;
								const attachResponse = await axios.post(
									`https://cdn.nerimity.com/attachments/${parseInt(
										channel_id
									)}/${nerimityCdnFileId}`,
									null,
									{ headers }
								);
								if (
									attachResponse.status === 200 &&
									attachResponse.data.fileId
								) {
									nerimityCdnFileId = attachResponse.data.fileId;
									payload["nerimityCdnFileId"] = nerimityCdnFileId;
								} else {
									await reportError(
										endpoint,
										new Error(`Failed to attach file to Nerimity CDN. Response: ${attachResponse.status}, ${attachResponse.statusText}`)
									);
									return false;
								}
							} else {
								await reportError(
									endpoint,
									new Error(`Failed to upload file to Nerimity CDN. Response: ${uploadResponse.status}, ${uploadResponse.statusText}`)
								);
								return false;
							}
						} catch (e) {
							await reportError(endpoint, wrapError("Error uploading attachment to nerimity", e));
							return false;
						}
					}
				} catch (e) {
					await reportError(endpoint, wrapError("Error uploading attachment to nerimity", e));
					return false;
				}
			}

			const targetUrl = webhook_url
				? webhook_url
				: `https://nerimity.com/api/channels/${channel_id}/messages`;
			const requestConfig = webhook_url ? {} : { headers };
			let response = await axios.post(targetUrl, payload, requestConfig);
			if (response.status !== 200) {
				await reportError(
					endpoint,
					new Error(`Failed to send message to Nerimity. Response: ${response.status}, ${response.statusText}`)
				);
				return false;
			}
			await markRead(endpoint, "nerimity");
			console.log("Sent to nerimity");
			return true;
		} else {
			return false;
		}
	} catch (e: any) {
		if (e.isAxiosError && e.response) {
			throw wrapError(
				`Failed to send to Nerimity: Status ${e.response.status}, ${e.response.statusText
				}, Body: ${JSON.stringify(e.response.data)}`,
				e
			);
		} else {
			throw wrapError("Failed to send to Nerimity", e);
		}
	}
}

export async function send_to_revolt(
	updated_json: UpdatedJson,
	endpoint: bigint,
	attachments: Attachment[] | null = null
) {
	if (updated_json.meta.read.revolt === false) {
		log("DEBUG", "Sending to revolt");
		let channel_id: string;
		try {
			let senderChannel: string;
			senderChannel = updated_json.meta.message["sender-channel"] ?? "";
			if (senderChannel === "") {
				throw new Error(
					`No sender channel found in message: ${JSON.stringify(
						updated_json.meta.message
					)}`
				);
			}
			if (updated_json.config.channels.discord.includes(senderChannel)) {
				channel_id =
					updated_json.config.channels.revolt[
					updated_json.config.channels.discord.indexOf(senderChannel)
					];
			} else if (updated_json.config.channels.guilded.includes(senderChannel)) {
				channel_id =
					updated_json.config.channels.revolt[
					updated_json.config.channels.guilded.indexOf(senderChannel)
					];
			} else if (
				updated_json.config.channels.nerimity.includes(senderChannel)
			) {
				channel_id =
					updated_json.config.channels.revolt[
					updated_json.config.channels.nerimity.indexOf(senderChannel)
					];
			} else {}
		} catch (e) {
			if (e instanceof Error) {
				throw e;
			}
			throw wrapError(formatSendError(e), e);
		}
		const headers = {
			"X-Bot-Token": updated_json.config.isbeta
				? process.env.BETA_REVOLT_TOKEN || process.env.REVOLT_TOKEN
				: process.env.REVOLT_TOKEN,
		};
		if (!headers["X-Bot-Token"]) {
			throw new Error(
				`Missing Revolt token for ${updated_json.config.isbeta ? "beta" : "live"} mode`
			);
		}
		const url = `https://api.stoat.chat/channels/${channel_id}/messages`;
		const payload = {
			masquerade: {
				avatar: updated_json.meta.message.author.avatar,
				name: updated_json.meta.message.author.name,
			},
			content: updated_json.meta.message.content,
		};

		try {
			const axiosResponse = await axios.post(url, payload, { headers });
			log(
				"INFO",
				`Sent to revolt. Response: ${axiosResponse.status}, ${axiosResponse.statusText
				} ${JSON.stringify(axiosResponse.data)}`
			);
			await markRead(endpoint, "revolt");
			log("INFO", "Sent to revolt");
			return true;
		} catch (e) {
			if (e instanceof Error) {
				throw e;
			}
			throw wrapError(formatSendError(e), e);
		}
	} else {
		log("DEBUG", "Skipping send_to_revolt because meta.read.revolt is already true");
		return true;
	}
}
