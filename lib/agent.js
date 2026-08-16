// Shared agent orchestration for Whale. These helpers wrap the core DSH
// Agent/Session services the same way `dsh-headless` does, so every Whale
// surface (one-shot `run`, terminal `chat`, the gateway, and channels) drives
// the exact same agent runtime.
//
// Conversations use a DETERMINISTIC session id (hash of the conversation key),
// so an evicted gateway conversation can be resumed from its persisted session
// instead of starting a fresh one.
import { randomUUID, createHash } from "node:crypto";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { getDefaultModel } from "./config.js";
import { renderMemorySnapshot } from "./memory.js";

/** Stable session id for one conversation key (channel:id). */
export function conversationSessionId(key) {
	const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
	return SessionId(`session-${hash}`);
}

function resolveSelection(defaultModel, modelOverride) {
	const selection = defaultModel.currentSelection();
	const whaleDefault = getDefaultModel();
	const provider = whaleDefault?.provider ?? selection.provider;
	const model = modelOverride ?? whaleDefault?.model ?? selection.model;
	return { ...selection, provider, model };
}

function requireCore(ctx) {
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	if (agents === void 0 || defaultModel === void 0) throw new Error("whale: core agent services (agents/agentDefaultModel) are not available");
	return { agents, defaultModel };
}

/** WeChat chat style: concise replies instead of the default verbose coding voice. */
export const WECHAT_CONCISE_SECTION = {
	name: "whale:wechat-style",
	order: 20,
	text: "You are replying inside WeChat. Keep replies short: usually 1-2 sentences, answer directly, no emoji, no bullet lists, and no filler (\"好的/明白了/当然可以\") unless the user explicitly asks for detail."
};

/**
 * Inject the frozen persistent-memory snapshot (MEMORY.md / USER.md) into the
 * agent's system prompt. Rendered once at session start so the block is a
 * stable snapshot for the whole session (Hermes Agent's frozen-snapshot
 * pattern, preserving prompt prefix caching); tool writes apply next session.
 */
function injectMemory(agentCtx) {
	try {
		const snapshot = renderMemorySnapshot();
		if (snapshot !== "") {
			agentCtx.systemPrompt?.section({ name: "whale:memory", order: 15, text: snapshot });
		}
	} catch {
		/* memory injection is best-effort */
	}
}

/**
 * The agent's working directory. `WHALE_WORKSPACE` pins it so it does not
 * follow the terminal's CWD (the `whale` shim sets it and cd's there);
 * otherwise it falls back to the launch directory.
 */
function resolveWorkspace() {
	return process.env.WHALE_WORKSPACE ?? process.cwd();
}

/**
 * Create one fresh, persisted Agent through the core registry, using the
 * currently selected default model.
 * @param ctx - plugin context carrying `agents` and `agentDefaultModel`.
 * @param meta - extra session meta merged over the default `{ cwd }`.
 * @param modelOverride - optional model id that wins over the default.
 * @param sessionId - optional explicit session id (deterministic for gateway).
 * @returns the created agent (already awaited to idle by the caller).
 */
export async function createWhaleAgent(ctx, meta = {}, modelOverride, sessionId, setupExtra) {
	const { agents, defaultModel } = requireCore(ctx);
	const current = resolveSelection(defaultModel, modelOverride);
	const { agent } = await agents.create({
		sessionId: sessionId ?? SessionId(`session-${randomUUID()}`),
		meta: { cwd: resolveWorkspace(), ...meta },
		agentOptions: {
			provider: current.provider,
			model: current.model
		},
		setup: (agentCtx) => {
			installModelSelection(agentCtx, {
				current,
				assembled: void 0
			});
			injectMemory(agentCtx);
			setupExtra?.(agentCtx);
		}
	});
	return agent;
}

/**
 * Resume an agent from a persisted session. Throws when the session was never
 * persisted (caller falls back to {@link createWhaleAgent}).
 * @param ctx - plugin context carrying `agents` and `agentDefaultModel`.
 * @param sessionId - the persisted session id to load.
 * @param modelOverride - optional model id that wins over the default.
 */
export async function resumeWhaleAgent(ctx, sessionId, modelOverride, setupExtra) {
	const { agents, defaultModel } = requireCore(ctx);
	const current = resolveSelection(defaultModel, modelOverride);
	const { agent } = await agents.resume({
		resumeSessionId: sessionId,
		agentOptions: {
			provider: current.provider,
			model: current.model
		},
		setup: (agentCtx) => {
			installModelSelection(agentCtx, {
				current,
				assembled: void 0
			});
			injectMemory(agentCtx);
			setupExtra?.(agentCtx);
		}
	});
	return agent;
}

/** Submit one user text message to an idle agent. */
export function submitText(agent, text) {
	agent.followup(createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "user" }
	}));
}

/**
 * Fold the last non-empty assistant text from a durable event interval.
 * Mirrors dsh-headless' summarize: each `assistant/message` event carries the
 * message content, and the final non-empty text wins.
 * @param events - the session event array.
 * @param firstSeq - the first sequence number owned by this turn.
 */
export function lastAssistantText(events, firstSeq) {
	let started = false;
	let text = "";
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = (event.data?.message?.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			if (joined !== "") text = joined;
		}
	}
	return text;
}
