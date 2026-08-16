// Whale persistent memory — aligned with Hermes Agent's Persistent Memory
// design: MEMORY.md (agent's personal notes, 2200 chars) + USER.md (user
// profile, 1375 chars) stored under `$DSH_HOME/memories/`, injected into the
// system prompt as a FROZEN snapshot at session start, and managed by the
// agent itself through the `memory` tool (add / replace / remove). When a
// store is full the tool errors instead of silently dropping entries, and the
// agent consolidates to make room — exactly like Hermes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "whale-memory";
const inject = ["tools"];

/** Per-store capacity, matching Hermes Agent's limits. */
export const MEMORY_LIMITS = { memory: 2200, user: 1375 };
const STORE_FILES = { memory: "MEMORY.md", user: "USER.md" };
const STORE_LABELS = { memory: "MEMORY (your personal notes)", user: "USER PROFILE (user)" };
const ENTRY_SEP = "\n§\n";

export function memoriesDir() {
	return join(process.env.DSH_HOME ?? ".", "memories");
}

function memoryFilePath(store) {
	return join(memoriesDir(), STORE_FILES[store]);
}

export function readMemory(store) {
	try {
		return readFileSync(memoryFilePath(store), "utf8");
	} catch {
		return "";
	}
}

/** { chars, limit, entries, pct } for one store. */
export function memoryUsage(store) {
	const text = readMemory(store);
	const entries = text.split(ENTRY_SEP).map((e) => e.trim()).filter((e) => e !== "");
	return {
		chars: text.length,
		limit: MEMORY_LIMITS[store],
		entries: entries.length,
		pct: Math.round((text.length / MEMORY_LIMITS[store]) * 100)
	};
}

export function writeMemory(store, content) {
	mkdirSync(memoriesDir(), { recursive: true });
	writeFileSync(memoryFilePath(store), content);
	return memoryUsage(store);
}

function entryList(text) {
	return text.split(ENTRY_SEP).map((e) => e.trim()).filter((e) => e !== "");
}

function joinEntries(entries) {
	return entries.join(ENTRY_SEP);
}

/** Locate the single entry containing `oldText`; error when ambiguous/absent. */
function findEntryIndex(entries, oldText) {
	if (oldText === "") throw new Error("old_text must be a non-empty substring of the entry to match");
	const matches = entries.filter((e) => e.includes(oldText));
	if (matches.length === 0) throw new Error(`no memory entry contains ${JSON.stringify(oldText)}`);
	if (matches.length > 1) throw new Error(`${JSON.stringify(oldText)} matches ${matches.length} entries; use a more specific old_text`);
	return entries.indexOf(matches[0]);
}

function requireContent(args, action) {
	if (typeof args.content !== "string" || args.content.trim() === "") {
		throw new Error(`${action} requires a non-empty content string`);
	}
	return args.content.trim();
}

function requireOldText(args, action) {
	if (typeof args.old_text !== "string" || args.old_text.trim() === "") {
		throw new Error(`${action} requires a non-empty old_text substring`);
	}
	return args.old_text.trim();
}

/** Execute one memory mutation; returns the live usage state. */
export function mutateMemory(args) {
	const action = args.action;
	const store = args.target;
	if (store !== "memory" && store !== "user") throw new Error(`unknown memory target ${JSON.stringify(store)}; use "memory" or "user"`);
	const limit = MEMORY_LIMITS[store];
	const text = readMemory(store);
	const entries = entryList(text);

	if (action === "add") {
		const content = requireContent(args, "add");
		const next = joinEntries([...entries, content]);
		if (next.length > limit) {
			throw new Error(`memory at ${text.length}/${limit} chars; adding this entry (${content.length} chars) would exceed the limit. Consolidate first: replace or remove entries, or shorten this one.`);
		}
		return writeMemory(store, next);
	}

	if (action === "replace") {
		const oldText = requireOldText(args, "replace");
		const content = requireContent(args, "replace");
		const idx = findEntryIndex(entries, oldText);
		const nextEntries = [...entries];
		nextEntries[idx] = content;
		const next = joinEntries(nextEntries);
		if (next.length > limit) {
			throw new Error(`memory at ${text.length}/${limit} chars; the replacement (${content.length} chars) still exceeds the limit. Shorten it or remove another entry first.`);
		}
		return writeMemory(store, next);
	}

	if (action === "remove") {
		const oldText = requireOldText(args, "remove");
		const idx = findEntryIndex(entries, oldText);
		const nextEntries = [...entries];
		nextEntries.splice(idx, 1);
		return writeMemory(store, joinEntries(nextEntries));
	}

	throw new Error(`unknown memory action ${JSON.stringify(action)}; use "add", "replace" or "remove"`);
}

/**
 * The frozen memory block rendered into the system prompt at session start.
 * Empty stores are omitted; a fully empty memory yields "" so the section can
 * be dropped (the agent then has no memory section to read).
 */
export function renderMemorySnapshot() {
	const blocks = [];
	for (const store of ["memory", "user"]) {
		const text = readMemory(store).trim();
		if (text === "") continue;
		const usage = memoryUsage(store);
		blocks.push(
			`═══ ${STORE_LABELS[store]} [${usage.pct}% — ${usage.chars}/${usage.limit} chars] ═══\n${text}`
		);
	}
	if (blocks.length === 0) return "";
	return `══════════════════════════════════════════\nPERSISTENT MEMORY — facts that survive across sessions\n══════════════════════════════════════════\n` + blocks.join("\n\n");
}

function apply(ctx) {
	ctx.tools.register(defineTool({
		name: "memory",
		description: "Manage your persistent memory, which survives across sessions and is injected into your system prompt at the start of every session. " +
			"SAVE PROACTIVELY — without being asked — when you learn something worth remembering: " +
			"user preferences, identity and communication style (\u2192 target \"user\"); " +
			"environment facts, project conventions, corrections, lessons learned, completed work (\u2192 target \"memory\"). " +
			"SKIP: trivial or rediscoverable facts, raw data dumps, session-specific ephemera, and anything already in the system prompt. " +
			"Entries are separated by \u00A7 and each store has a hard character limit; when a write would overflow, the tool errors — then consolidate or shorten in the same turn and retry. " +
			"Memory changes persist to disk immediately but appear in the system prompt only from the next session.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["add", "replace", "remove"],
				description: "add = append a new entry; replace = update one entry (match by unique substring); remove = delete one entry (match by unique substring)"
			},
			target: {
				type: "string",
				required: true,
				enum: ["memory", "user"],
				description: "memory = your personal notes (2200 chars max); user = user profile (1375 chars max)"
			},
			content: {
				type: "string",
				description: "The new entry text (required for add and replace)"
			},
			old_text: {
				type: "string",
				description: "A short unique substring identifying the entry to replace or remove (required for replace and remove)"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true },
					store: { type: "string", required: true },
					chars: { type: "integer", required: true },
					limit: { type: "integer", required: true },
					entries: { type: "integer", required: true }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Memory (${value.store}) updated: ${value.entries} entries, ${value.chars}/${value.limit} chars.`
			}]
		},
		execute(args) {
			const usage = mutateMemory(args);
			return Promise.resolve({ success: true, store: args.target, chars: usage.chars, limit: usage.limit, entries: usage.entries });
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Memory: ${args.action} ${args.target}`,
			kind: "other",
			rawInput: args
		})
	}));
}

export { apply, inject, name };
