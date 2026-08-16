// Whale gateway: the HTTP surface every channel (and any external client)
// shares. It exposes a small JSON API and routes inbound channel messages to
// a per-conversation agent session, replying through the channel's `send`.
//
// Routes:
//   GET  /health                        liveness + channel ids
//   GET  /v1/channels                   list registered channels
//   POST /v1/message {text, session?}   run one turn, return {reply}
//   POST /v1/channels/wechat/webhook    optional bridge-style inbound
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WHALE_STARTUP_SERVICE, WHALE_VERSION } from "./startup.js";
import { WHALE_CHANNELS_SERVICE } from "./channels.js";
import { createWhaleAgent, resumeWhaleAgent, conversationSessionId, submitText, lastAssistantText, WECHAT_CONCISE_SECTION } from "./agent.js";
import { whaleWorkspace } from "./config.js";

const name = "whale-gateway";
const inject = [WHALE_STARTUP_SERVICE, WHALE_CHANNELS_SERVICE];

/**
 * On Windows, give this process a *hidden* console when it currently has none
 * (the web-ui background gateway is spawned with windowsHide: true, so it is
 * console-less). A console-less daemon forces every console-subsystem child it
 * spawns (bash, pwsh, cmd, node, ...) to allocate its own visible conhost
 * window — the flashing black box seen when the agent runs a command. Owning
 * one hidden console means every descendant inherits it instead of flashing
 * (the same design as Hermes Agent's gateway_windows.py). No-op when a console
 * already exists (manual `whale serve` in a terminal) and on non-Windows.
 */
async function ensureHiddenWindowsConsole() {
	if (process.platform !== "win32") return;
	try {
		const koffi = (await import("koffi")).default;
		const kernel32 = koffi.load("kernel32.dll");
		const user32 = koffi.load("user32.dll");
		const AllocConsole = kernel32.func("int AllocConsole(void)");
		const GetConsoleWindow = kernel32.func("void *GetConsoleWindow(void)");
		const ShowWindow = user32.func("int ShowWindow(void *hWnd, int nCmdShow)");
		if (!AllocConsole()) return; // already attached to a console — nothing to hide
		const hwnd = GetConsoleWindow();
		if (hwnd) ShowWindow(hwnd, 0 /* SW_HIDE */);
		process.stdout.write("[whale] hidden console allocated for background gateway\n");
	} catch {
		/* koffi unavailable — best effort only; behaviour degrades to the old flashing-console path */
	}
}

function apply(ctx) {
	const startup = ctx.get(WHALE_STARTUP_SERVICE);
	if (startup.command !== "serve") return;

	// Pin the process cwd to the whale workspace. Agent command executors
	// follow process.cwd() (not WHALE_WORKSPACE env), and a gateway spawned
	// from an arbitrary terminal cwd (e.g. C:\Users\Administrator or
	// D:\dsh\workspace) otherwise makes every agent command — and any
	// "the desktop" resolution — run in the wrong directory.
	try {
		const target = whaleWorkspace();
		if (process.cwd() !== target) process.chdir(target);
	} catch {
		/* best-effort cwd pin */
	}

	// Allocate the hidden console before any agent command can spawn a child,
	// so every command subprocess inherits it and no window ever flashes.
	void ensureHiddenWindowsConsole();

	const { host, port } = startup.opts;
	const channels = ctx.get(WHALE_CHANNELS_SERVICE);
	const sessions = ctx.get("sessions");
	// Web UI page served at `/` (read once at boot; a missing file degrades to 404).
	let webUiHtml;
	try {
		webUiHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "webui", "index.html"), "utf8");
	} catch {
		webUiHtml = void 0;
	}
	// Conversation cache with LRU + TTL eviction: without it, one agent (a full
	// session, hundreds of MB) is held per conversation forever. Evicted
	// sessions are flushed (persisted) and dropped; a later message recreates a
	// fresh agent. Tune via WHALE_MAX_CONVERSATIONS / WHALE_CONVERSATION_TTL_MINUTES.
	const MAX_CONVERSATIONS = Number(process.env.WHALE_MAX_CONVERSATIONS ?? 100);
	const CONVERSATION_TTL_MS = Number(process.env.WHALE_CONVERSATION_TTL_MINUTES ?? 30) * 60 * 1000;
	const conversations = new Map(); // key -> { agent, lastAccess }
	// Per-conversation reset epoch: `/new` bumps this so the next turn gets a
	// fresh session instead of resuming the deterministic one. In-memory only,
	// so a `/new` reset is lost across a serve restart (the original session
	// resumes from disk).
	const sessionEpoch = new Map(); // key -> epoch token

	function evict(key, entry) {
		conversations.delete(key);
		try {
			// Attach a rejection handler so a failed flush on eviction cannot
			// surface as an unhandled promise rejection and crash the gateway.
			sessions?.flush(entry.agent.session)?.catch(() => {
				/* flush is best-effort on eviction */
			});
		} catch {
			/* flush is best-effort on eviction */
		}
	}

	function evictStale(now = Date.now()) {
		for (const [key, entry] of conversations) {
			if (now - entry.lastAccess > CONVERSATION_TTL_MS) evict(key, entry);
		}
		while (conversations.size > MAX_CONVERSATIONS) {
			let oldestKey;
			let oldestAt = Infinity;
			for (const [key, entry] of conversations) {
				if (entry.lastAccess < oldestAt) {
					oldestAt = entry.lastAccess;
					oldestKey = key;
				}
			}
			if (oldestKey === void 0) break;
			evict(oldestKey, conversations.get(oldestKey));
		}
	}

	/** Deterministic session id for a conversation key, honoring any `/new` reset. */
	function sessionIdFor(key) {
		const epoch = sessionEpoch.get(key) ?? "";
		return conversationSessionId(epoch === "" ? key : `${key}:${epoch}`);
	}

	/** Drop the cached agent and pin a fresh session id for this conversation. */
	function resetConversation(key) {
		sessionEpoch.set(key, randomUUID());
		const entry = conversations.get(key);
		if (entry !== void 0) {
			conversations.delete(key);
			try {
				sessions?.flush(entry.agent.session)?.catch(() => {
					/* best-effort */
				});
			} catch {
				/* best-effort */
			}
		}
	}

	async function agentFor(key, modelOverride) {
		evictStale();
		let entry = conversations.get(key);
		if (entry !== void 0) {
			entry.lastAccess = Date.now();
			return entry.agent;
		}
		// WeChat conversations get a concise chat persona and a fixed workspace
		// (never the launch cwd, which can put the temp dir inside the sandbox).
		const isWechat = key.startsWith("wechat:");
		const setupExtra = isWechat
			? (agentCtx) => {
					agentCtx.systemPrompt?.section(WECHAT_CONCISE_SECTION);
				}
			: void 0;
		// Resumed sessions keep their PERSISTED cwd (possibly created by an older
		// gateway context, e.g. C:\Users\Administrator), which makes the agent
		// resolve "the desktop" and run commands in the wrong place. Pin the
		// session header's cwd back to the whale workspace on every resume.
		const resumeSetup = (agentCtx) => {
			try {
				const header = agentCtx.agent?.session?.header;
				if (header !== void 0 && typeof header === "object") {
					header.cwd = whaleWorkspace();
				}
			} catch {
				/* best-effort cwd pin */
			}
			setupExtra?.(agentCtx);
		};
		const sessionId = sessionIdFor(key);
		let agent;
		try {
			agent = await resumeWhaleAgent(ctx, sessionId, modelOverride, resumeSetup);
		} catch {
			agent = await createWhaleAgent(ctx, { cwd: whaleWorkspace() }, modelOverride, sessionId, setupExtra);
		}
		await agent.whenIdle();
		entry = { agent, lastAccess: Date.now() };
		conversations.set(key, entry);
		return entry.agent;
	}

	async function turn(agent, text) {
		const firstSeq = agent.session.seq;
		submitText(agent, text);
		await agent.whenIdle();
		if (sessions !== void 0) await sessions.flush(agent.session);
		return lastAssistantText(agent.session.events, firstSeq);
	}

	/** Route one inbound channel message to the agent and reply through `send`. */
	async function routeInbound(channel, message) {
		const key = `${channel.id}:${message.conversationId}`;
		// `/new` (or an alias) starts a fresh session instead of a turn.
		const command = (message.text ?? "").trim();
		if (command === "/new" || command === "/reset" || command === "/clear" || command === "/新会话" || command === "/重置") {
			resetConversation(key);
			const ack = "已开始新会话，之前的内容已清空 ✓";
			let send = { ok: false, reason: "no sender" };
			if (message.from && message.from !== "unknown") {
				try {
					send = await channel.send(message.from, ack, message.contextToken);
				} catch (error) {
					send = { ok: false, reason: error?.message ?? String(error) };
				}
			}
			return { reply: ack, send };
		}
		const agent = await agentFor(key, channel.model);
		let typing = false;
		try {
			if (typeof channel.startTyping === "function") {
				await channel.startTyping(message);
				typing = true;
			}
		} catch {
			/* typing indicator is best-effort */
		}
		let reply;
		try {
			reply = await turn(agent, message.text);
		} finally {
			if (typing) {
				try {
					await channel.stopTyping?.(message);
				} catch {
					/* best-effort */
				}
			}
		}
		let send = { ok: false, reason: "no sender" };
		if (message.from && message.from !== "unknown") {
			try {
				send = await channel.send(message.from, reply, message.contextToken);
			} catch (error) {
				send = { ok: false, reason: error?.message ?? String(error) };
			}
		}
		return { reply, send };
	}

	function json(res, code, body) {
		const data = JSON.stringify(body);
		res.writeHead(code, {
			"content-type": "application/json",
			"content-length": Buffer.byteLength(data)
		});
		res.end(data);
	}

	async function readBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		if (raw.trim() === "") return {};
		return JSON.parse(raw);
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${host}:${port}`);
		try {
			if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
				if (webUiHtml !== void 0) {
					res.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"content-length": Buffer.byteLength(webUiHtml)
					});
					res.end(webUiHtml);
				} else {
					json(res, 404, { error: "web UI not found" });
				}
				return;
			}

			if (req.method === "GET" && url.pathname === "/health") {
				json(res, 200, {
					ok: true,
					service: "whale",
					version: WHALE_VERSION,
					channels: (channels?.list() ?? []).map((c) => ({ id: c.id, status: c.status }))
				});
				return;
			}

			if (req.method === "GET" && url.pathname === "/v1/channels") {
				json(res, 200, {
					channels: (channels?.list() ?? []).map((c) => ({ id: c.id, name: c.name, status: c.status, ...(c.model ? { model: c.model } : {}) }))
				});
				return;
			}

			if (req.method === "POST" && url.pathname === "/v1/message") {
				const body = await readBody(req);
				const text = typeof body.text === "string" ? body.text : String(body.text ?? "");
				if (text.trim() === "") {
					json(res, 400, { error: "text is required" });
					return;
				}
				const key = typeof body.session === "string" && body.session !== "" ? body.session : "default";
				const agent = await agentFor(`gateway:${key}`);
				const reply = await turn(agent, text);
				json(res, 200, { reply });
				return;
			}

			if (req.method === "POST" && url.pathname === "/v1/channels/wechat/webhook") {
				const body = await readBody(req);
				const wechat = channels?.get?.("wechat");
				if (wechat === void 0) {
					json(res, 404, { error: "wechat channel not registered" });
					return;
				}
				const message = wechat.parseInbound?.(body);
				if (message === void 0) {
					json(res, 400, { error: "unrecognized inbound message" });
					return;
				}
				json(res, 200, await routeInbound(wechat, message));
				return;
			}

			json(res, 404, { error: "not found" });
		} catch (error) {
			json(res, 500, { error: error?.message ?? String(error) });
		}
	});

	server.listen(port, host, () => {
		process.stdout.write(`whale gateway listening on http://${host}:${port}\n`);
		process.stdout.write("  POST /v1/message                  run one turn\n");
		process.stdout.write("  GET  /v1/channels                 list channels\n");
		process.stdout.write("  POST /v1/channels/wechat/webhook  optional bridge-style inbound\n");
		for (const channel of channels?.list() ?? []) {
			channel.onMessage?.(async (message) => {
				try {
					await routeInbound(channel, message);
				} catch (error) {
					ctx.logger?.warn?.(`whale: channel ${channel.id} inbound failed: ${error?.message ?? String(error)}`);
				}
			});
			try {
				channel.start?.();
			} catch (error) {
				ctx.logger?.warn?.(`whale: failed to start channel ${channel.id}: ${error?.message ?? String(error)}`);
			}
		}
	});

	ctx.effect(function* () {
		yield () => {
			for (const channel of channels?.list() ?? []) {
				try {
					channel.stop?.();
				} catch {
					/* ignore stop errors during teardown */
				}
			}
			return new Promise((resolve) => server.close(() => resolve()));
		};
	}, "whale-gateway server");
}

export { apply, inject, name };
