import { getDb } from "./utils/pgsql";

export async function getEmoji(
	emoji: string,
	endpoint: bigint,
	sender: string
): Promise<any | null> {
	const db = await getDb();
	try {
		const res = await db.query(
			"SELECT data->'config'->'emojis' as emojis FROM endpoints WHERE id = $1",
			[endpoint.toString()]
		);
		if (res.rows.length === 0) return null;
		const emojiList = res.rows[0].emojis;
		for (const emojiData of emojiList) {
			if (emojiData[sender] === emoji) return emojiData;
		}
		return null;
	} finally {
		db.release();
	}
}

export async function convertEmoji(
	emoji: string,
	sender: string,
	receiver: string,
	endpoint: bigint
): Promise<string | null> {
	const emojiData = await getEmoji(emoji, endpoint, sender);
	if (!emojiData) return null;
	return emojiData[receiver] || emoji;
}

export async function convertMessage(
	message: string,
	sender: string,
	receiver: string,
	endpoint: bigint
): Promise<string | undefined> {
	if (!message) return message;
	let regex: RegExp;
	if (sender === "discord") regex = /<a?:\w+:\d+>|:\w+:/g;
	else if (sender === "guilded" || sender === "revolt") regex = /:\w+:/g;
	else if (sender === "nerimity") regex = /\[ace:\d+:\w+\]|\[ce:\d+:\w+\]/g;
	else return message;

	const emojis = message.match(regex) || [];
	for (const emoji of emojis) {
		const emojiData = await convertEmoji(emoji, sender, receiver, endpoint);
		if (emojiData) {
			message = message.replace(emoji, emojiData);
		} else {
			const db = await getDb();
			try {
				const res = await db.query(
					"SELECT data->'config'->'emoji_filtering' as emoji_filtering FROM endpoints WHERE id = $1",
					[endpoint]
				);
				if (res.rows.length > 0 && res.rows[0]?.emoji_filtering) {
					message = message.replace(emoji, "");
				}
			} finally {
				db.release();
			}
		}
	}

	return message;
}

export async function addEmoji(endpoint: BigInt, emoji: any): Promise<any> {
	const db = await getDb();
	try {
		const res = await db.query(
			"SELECT data->'config' as config FROM endpoints WHERE id = $1",
			[endpoint]
		);
		if (res.rows.length === 0) throw new Error("Endpoint not found");
		const config = res.rows[0].config;
		config.emojis = config.emojis || [];
		config.emojis.push(emoji);
		await db.query(
			"UPDATE endpoints SET data = jsonb_set(data, '{config}', $1::jsonb, true) WHERE id = $2",
			[JSON.stringify(config), endpoint]
		);
		return {
			message: `Added emoji ${JSON.stringify(emoji)} to endpoint ${endpoint}`,
		};
	} finally {
		db.release();
	}
}

export async function removeEmoji(endpoint: BigInt, emoji: any): Promise<any> {
	const db = await getDb();
	try {
		const res = await db.query(
			"SELECT data->'config' as config FROM endpoints WHERE id = $1",
			[endpoint]
		);
		if (res.rows.length === 0) throw new Error("Endpoint not found");
		const config = res.rows[0].config;
		config.emojis = (config.emojis || []).filter((e: any) => {
			return !(
				(e.discord && e.discord === emoji.discord) ||
				(e.nerimity && e.nerimity === emoji.nerimity) ||
				(e.guilded && e.guilded === emoji.guilded) ||
				(e.revolt && e.revolt === emoji.revolt)
			);
		});
		await db.query(
			"UPDATE endpoints SET data = jsonb_set(data, '{config}', $1::jsonb, true) WHERE id = $2",
			[JSON.stringify(config), endpoint]
		);
		return { message: `Removed emoji from endpoint ${endpoint}` };
	} finally {
		db.release();
	}
}

export async function updateEmoji(endpoint: BigInt, emoji: any): Promise<any> {
	const db = await getDb();
	try {
		const res = await db.query(
			"SELECT data->'config' as config FROM endpoints WHERE id = $1",
			[endpoint]
		);
		if (res.rows.length === 0) throw new Error("Endpoint not found");
		const config = res.rows[0].config;
		for (const emojiData of config.emojis || []) {
			if (emojiData.discord) emojiData.discord = emoji.discord;
			if (emojiData.nerimity) emojiData.nerimity = emoji.nerimity;
			if (emojiData.guilded) emojiData.guilded = emoji.guilded;
			if (emojiData.revolt) emojiData.revolt = emoji.revolt;
		}
		await db.query(
			"UPDATE endpoints SET data = jsonb_set(data, '{config}', $1::jsonb, true) WHERE id = $2",
			[JSON.stringify(config), endpoint]
		);
		return { message: `Updated emoji ${emoji.discord} in endpoint ${endpoint}` };
	} finally {
		db.release();
	}
}
