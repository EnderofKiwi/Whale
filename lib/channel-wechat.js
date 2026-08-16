// Whale WeChat channel — native Tencent iLink Bot API client (微信 ClawBot).
//
// Tencent's official personal-WeChat bot API lives at
// https://ilinkai.weixin.qq.com (protocol "iLink"). Login is a one-time QR
// scan: fetch a QR code, the user scans it in WeChat, and the server returns a
// `bot_token`. After that the channel long-polls `/ilink/bot/getupdates` for
// inbound messages and sends replies via `/ilink/bot/sendmessage`, carrying the
// inbound message's `context_token` so the reply lands in the right chat.
//
// This is the same flow Marvis / WorkBuddy use: "扫码即可", no local
// endpoint to configure. The token persists to a file so the QR scan happens
// only once.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createDecipheriv } from "node:crypto";
import { WHALE_CHANNELS_SERVICE } from "./channels.js";
import { getWechatModel } from "./config.js";

const name = "whale-channel-wechat";
const inject = [WHALE_CHANNELS_SERVICE];

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "1.0.2";
const POLL_RETRY_MS = 2000;
const LOGIN_POLL_MS = 1500;

/** Random anti-replay nonce: uint32 -> decimal string -> base64. */
function randomUin() {
	const value = (Math.random() * 0xffffffff) >>> 0;
	return Buffer.from(String(value), "utf8").toString("base64");
}

function authHeaders(token) {
	const headers = {
		"Content-Type": "application/json",
		"AuthorizationType": "ilink_bot_token",
		"X-WECHAT-UIN": randomUin()
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function apiPost(baseUrl, path, body, token) {
	const response = await fetch(baseUrl + path, {
		method: "POST",
		headers: authHeaders(token),
		body: JSON.stringify(body)
	});
	return await response.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- iLink CDN media download / decrypt ----
// Inbound message item types (item_list[].type). `message_type === 1` marks a
// user-originated message regardless of what item types it carries.
const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

/** AES-128-ECB decrypt with PKCS#7 unpadding (the iLink CDN media cipher). */
function aes128EcbDecrypt(ciphertext, key) {
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	if (padded.length === 0) return padded;
	const padLen = padded[padded.length - 1];
	if (padLen >= 1 && padLen <= 16) {
		let valid = true;
		for (let i = 1; i <= padLen; i++) {
			if (padded[padded.length - i] !== padLen) { valid = false; break; }
		}
		if (valid) return padded.subarray(0, padded.length - padLen);
	}
	return padded;
}

/**
 * iLink's `aes_key` is base64 of either raw 16 bytes (image) or the 32-char
 * hex ASCII of the 16-byte key (file/voice/video). Return the 16-byte key.
 */
function parseAesKey(aesKeyB64) {
	const decoded = Buffer.from(aesKeyB64, "base64");
	if (decoded.length === 16) return decoded;
	if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
		return Buffer.from(decoded.toString("ascii"), "hex");
	}
	throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`);
}

function apply(ctx, config = {}) {
	const channels = ctx.get(WHALE_CHANNELS_SERVICE);

	const base = config.baseUrl ?? process.env.WHALE_WECHAT_BASE_URL ?? DEFAULT_BASE;
	const cdnBase = process.env.WHALE_WECHAT_CDN_BASE_URL ?? DEFAULT_CDN_BASE;
	const home = process.env.DSH_HOME ?? ".";
	const mediaDir = join(home, "wechat-media");
	const tokenFile = config.tokenFile ?? process.env.WHALE_WECHAT_TOKEN_FILE ?? join(home, "whale-wechat-token.json");
	// WeChat replies use a fast model by default (snappier chat). Override via
	// `whale models wechat <model>`, WHALE_WECHAT_MODEL, or config.model.
	const channelModel = config.model ?? process.env.WHALE_WECHAT_MODEL ?? getWechatModel("deepseek-v4-flash");

	let botToken = config.botToken ?? process.env.WHALE_WECHAT_BOT_TOKEN;
	let baseUrl = base;
	let cursor = "";
	let running = false;
	let inboundHandler = () => {};
	// Dedupe already-processed inbound messages (getupdates can re-deliver a
	// message across long-poll cycles; without this one WeChat message produces
	// several identical replies).
	const seenMessageIds = new Set();
	const MAX_SEEN_IDS = 2000;
	// Per-user typing_ticket cache (valid 24h per the iLink SDK behavior).
	const typingTickets = new Map(); // fromId -> { ticket, expiresAt }

	function mediaItemKey(type) {
		switch (type) {
			case ITEM.IMAGE: return "image_item";
			case ITEM.VOICE: return "voice_item";
			case ITEM.FILE: return "file_item";
			case ITEM.VIDEO: return "video_item";
			default: return void 0;
		}
	}

	function mediaLabel(type) {
		switch (type) {
			case ITEM.IMAGE: return "图片";
			case ITEM.VOICE: return "语音";
			case ITEM.FILE: return "文件";
			case ITEM.VIDEO: return "视频";
			default: return "媒体";
		}
	}

	/** Download one inbound media item from the CDN, decrypt it, and persist it. */
	async function saveInboundMedia(item) {
		const key = mediaItemKey(item.type);
		if (key === void 0) return void 0;
		const sub = item[key] ?? {};
		const media = sub.media ?? {};
		let url;
		if (typeof media.encrypt_query_param === "string" && media.encrypt_query_param !== "") {
			url = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
		} else if (typeof media.full_url === "string" && media.full_url !== "") {
			url = media.full_url;
		} else {
			throw new Error("media item has neither encrypt_query_param nor full_url");
		}
		const res = await fetch(url);
		if (!res.ok) throw new Error(`CDN download HTTP ${res.status}`);
		let bytes = Buffer.from(await res.arrayBuffer());

		let keyBytes = null;
		if (item.type === ITEM.IMAGE && typeof sub.aeskey === "string" && /^[0-9a-fA-F]{32}$/.test(sub.aeskey)) {
			// image_item.aeskey is the raw 16-byte key as hex (older API shape).
			keyBytes = Buffer.from(sub.aeskey, "hex");
		} else if (typeof media.aes_key === "string" && media.aes_key !== "") {
			keyBytes = parseAesKey(media.aes_key);
		}
		if (keyBytes !== null) bytes = aes128EcbDecrypt(bytes, keyBytes);

		mkdirSync(mediaDir, { recursive: true });
		const ts = Date.now();
		const rand = ((Math.random() * 0xffff) >>> 0).toString(16);
		let fileName;
		if (item.type === ITEM.FILE) {
			const raw = basename(typeof sub.file_name === "string" && sub.file_name !== "" ? sub.file_name : "document.bin");
			const safe = raw.replace(/[^\w.\-]+/g, "_");
			fileName = `${ts}_${rand}_${safe}`;
		} else {
			const ext = item.type === ITEM.IMAGE ? ".jpg" : item.type === ITEM.VOICE ? ".silk" : ".mp4";
			fileName = `${ts}_${rand}${ext}`;
		}
		const path = join(mediaDir, fileName);
		writeFileSync(path, bytes);
		return { kind: item.type, label: mediaLabel(item.type), path };
	}

	function loadToken() {
		try {
			const saved = JSON.parse(readFileSync(tokenFile, "utf8"));
			botToken = saved.bot_token;
			baseUrl = saved.baseurl ?? base;
			cursor = saved.cursor ?? "";
			return Boolean(botToken);
		} catch {
			return false;
		}
	}

	function saveToken() {
		try {
			writeFileSync(tokenFile, JSON.stringify({ bot_token: botToken, baseurl: baseUrl, cursor }, null, 2));
		} catch (error) {
			ctx.logger?.warn?.(`whale: failed to persist WeChat token: ${error?.message ?? String(error)}`);
		}
	}

	function displayQr(qr) {
		const content = qr.qrcode_img_content ?? qr.url ?? "";
		if (typeof content !== "string" || content === "") return;
		if (content.startsWith("http://") || content.startsWith("https://")) {
			process.stdout.write("WeChat ClawBot login — copy this link and open it in WeChat on your phone\n  (e.g. send it to yourself via 文件传输助手 and tap it, or turn it into a QR and scan):\n  " + content + "\n");
			return;
		}
		// Fallback: treat the value as base64 image bytes (older API shapes).
		try {
			const imagePath = join(home, "whale-wechat-qr.png");
			writeFileSync(imagePath, Buffer.from(content, "base64"));
			process.stdout.write(`QR image saved to ${imagePath} — open it and scan with WeChat.\n`);
		} catch {
			process.stdout.write(`WeChat ClawBot login QR: ${content}\n`);
		}
	}

	async function login() {
		const qrRes = await fetch(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`);
		const qr = await qrRes.json();
		displayQr(qr);
		const qrcode = qr.qrcode;
		if (!qrcode) throw new Error("whale: WeChat login QR did not include a qrcode id");
		process.stdout.write("whale: waiting for WeChat scan…\n");
		while (running) {
			const statusRes = await fetch(`${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
			const status = await statusRes.json();
			if (status.status === "confirmed") {
				botToken = status.bot_token;
				baseUrl = status.baseurl ?? base;
				saveToken();
				process.stdout.write("whale: WeChat ClawBot logged in.\n");
				return true;
			}
			if (status.status === "expired" || status.status === "failed" || status.status === "canceled") {
				process.stderr.write(`whale: WeChat login ${status.status}; restart serve to retry.\n`);
				return false;
			}
			await sleep(LOGIN_POLL_MS);
		}
		return false;
	}

	async function pollLoop() {
		while (running) {
			try {
				const res = await apiPost(baseUrl, "/ilink/bot/getupdates", {
					get_updates_buf: cursor,
					base_info: { channel_version: CHANNEL_VERSION }
				}, botToken);
				if (res?.get_updates_buf) {
					cursor = res.get_updates_buf;
					saveToken();
				}
				for (const msg of res?.msgs ?? []) {
					if (msg.message_type !== 1) continue; // user-originated only
					const msgId = String(msg.message_id ?? `${msg.seq ?? ""}:${msg.from_user_id ?? ""}:${msg.context_token ?? ""}`);
					if (seenMessageIds.has(msgId)) {
						process.stdout.write(`[wechat] skip duplicate message ${msgId}\n`);
						continue;
					}
					seenMessageIds.add(msgId);
					if (seenMessageIds.size > MAX_SEEN_IDS) {
						const it = seenMessageIds.values();
						while (seenMessageIds.size > MAX_SEEN_IDS) seenMessageIds.delete(it.next().value);
					}
					const textParts = [];
					const media = [];
					for (const item of msg.item_list ?? []) {
						if (item.type === ITEM.TEXT) {
							const text = item.text_item?.text;
							if (typeof text === "string" && text.trim() !== "") textParts.push(text.trim());
							continue;
						}
						if (item.type === ITEM.IMAGE || item.type === ITEM.VOICE || item.type === ITEM.FILE || item.type === ITEM.VIDEO) {
							try {
								const saved = await saveInboundMedia(item);
								if (saved) media.push(saved);
							} catch (error) {
								ctx.logger?.warn?.(`whale: WeChat media download failed: ${error?.message ?? String(error)}`);
							}
						}
					}
					const text = textParts.join("\n");
					if (text === "" && media.length === 0) continue;
					const mediaNote = media.length > 0
						? media.map((m) => `[收到${m.label}，已保存到: ${m.path}]`).join("\n")
						: "";
					const combined = [text, mediaNote].filter((part) => part !== "").join("\n");
					await inboundHandler({
						channel: "wechat",
						from: msg.from_user_id ?? "unknown",
						to: msg.to_user_id,
						text: combined,
						media: media.map((m) => ({ kind: m.kind, label: m.label, path: m.path })),
						conversationId: msg.from_user_id ?? "unknown",
						contextToken: msg.context_token,
						raw: msg
					});
				}
			} catch (error) {
				ctx.logger?.warn?.(`whale: WeChat getupdates error: ${error?.message ?? String(error)}`);
				await sleep(POLL_RETRY_MS);
			}
		}
	}

	async function getTypingTicket(fromId, contextToken) {
		const cached = typingTickets.get(fromId);
		if (cached !== void 0 && cached.expiresAt > Date.now()) return cached.ticket;
		try {
			const cfg = await apiPost(baseUrl, "/ilink/bot/getconfig", {
				ilink_user_id: fromId,
				context_token: contextToken,
				base_info: { channel_version: CHANNEL_VERSION }
			}, botToken);
			const ticket = cfg?.typing_ticket ?? "";
			if (ticket !== "") typingTickets.set(fromId, { ticket, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
			return ticket;
		} catch {
			return "";
		}
	}

	async function sendTyping(fromId, ticket, status) {
		await apiPost(baseUrl, "/ilink/bot/sendtyping", {
			ilink_user_id: fromId,
			typing_ticket: ticket,
			status
		}, botToken);
	}

	const channel = {
		id: "wechat",
		name: "WeChat (ClawBot)",
		status: botToken ? "configured" : "login-required",
		model: channelModel,

		async start() {
			running = true;
			try {
				if (!botToken) loadToken();
				if (!botToken) {
					process.stdout.write("whale: WeChat channel needs a one-time QR login.\n");
					const confirmed = await login();
					if (!confirmed) {
						channel.status = "login-required";
						running = false;
						return;
					}
				}
				channel.status = "running";
				void pollLoop();
			} catch (error) {
				channel.status = "offline";
				ctx.logger?.warn?.(`whale: WeChat channel failed to start: ${error?.message ?? String(error)}`);
			}
		},

		stop() {
			running = false;
		},

		onMessage(callback) {
			inboundHandler = callback;
		},

		async startTyping(message) {
			if (!botToken) return;
			try {
				const ticket = await getTypingTicket(message.from, message.contextToken);
				if (ticket !== "") await sendTyping(message.from, ticket, 1);
			} catch {
				/* typing is best-effort; never block a reply on it */
			}
		},

		async stopTyping(message) {
			if (!botToken) return;
			try {
				const ticket = typingTickets.get(message.from)?.ticket;
				if (ticket !== void 0 && ticket !== "") await sendTyping(message.from, ticket, 2);
			} catch {
				/* best-effort */
			}
		},

		async send(to, text, contextToken) {
			if (!botToken) throw new Error("whale: WeChat channel is not logged in");
			const clientId = `whale-${((Math.random() * 0xffffffff) >>> 0).toString(16)}`;
			const res = await apiPost(baseUrl, "/ilink/bot/sendmessage", {
				msg: {
					to_user_id: to,
					message_type: 2,
					message_state: 2,
					client_id: clientId,
					...(contextToken ? { context_token: contextToken } : {}),
					item_list: [{ type: 1, text_item: { text } }]
				},
				base_info: { channel_version: CHANNEL_VERSION }
			}, botToken);
			return { ok: res?.ret === 0, res };
		},

		// Convenience for bridge-style webhooks that forward a raw payload.
		parseInbound(payload) {
			if (payload === null || typeof payload !== "object") return void 0;
			const text = payload.content ?? payload.text ?? payload.message ?? payload.Content;
			if (typeof text !== "string" || text.trim() === "") return void 0;
			const from = payload.from ?? payload.sender ?? payload.from_user_id ?? payload.FromUserName;
			const conversationId = payload.conversationId ?? payload.chatId ?? payload.groupId ?? from;
			return {
				channel: "wechat",
				from: from === void 0 ? "unknown" : String(from),
				to: payload.to ?? payload.to_user_id,
				text: text.trim(),
				conversationId: conversationId === void 0 ? "unknown" : String(conversationId),
				contextToken: payload.context_token ?? payload.contextToken,
				raw: payload
			};
		}
	};

	const unregister = channels.register(channel);
	ctx.effect(function* () {
		yield () => unregister();
	}, "whale-channel-wechat");
}

export { apply, inject, name };
