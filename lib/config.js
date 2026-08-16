// Whale's small persisted config, shared by the CLI (`whale models ...`) and
// the channels that read model overrides at startup. Config lives at
// `$DSH_HOME/whale-config.json`; provider API keys and pi-ai routes are written
// into the harness's own `$DSH_HOME/.credentials.yaml` and `settings.yaml`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { load, dump } from "js-yaml";

function homePath(...parts) {
	return join(process.env.DSH_HOME ?? ".", ...parts);
}

export function whaleConfigPath() {
	return homePath("whale-config.json");
}

export function readWhaleConfig() {
	try {
		return JSON.parse(readFileSync(whaleConfigPath(), "utf8"));
	} catch {
		return {};
	}
}

export function writeWhaleConfig(patch) {
	const next = { ...readWhaleConfig(), ...patch };
	writeFileSync(whaleConfigPath(), JSON.stringify(next, null, 2) + "\n");
	return next;
}

/** Read the WeChat channel's model override, falling back to `fallback`. */
export function getWechatModel(fallback) {
	const value = readWhaleConfig().wechatModel;
	return typeof value === "string" && value !== "" ? value : fallback;
}

/** Read the user's default model override ({provider, model}), if any. */
export function getDefaultModel() {
	const value = readWhaleConfig().defaultModel;
	if (value && typeof value.provider === "string" && typeof value.model === "string") return value;
	return void 0;
}

/**
 * First-run onboarding marker. `isOnboarded()` is false on a fresh install so a
 * bare `whale` can route into the setup (welcome + model config). True once the
 * user has completed setup (or already has a default model configured).
 */
export function isOnboarded() {
	const cfg = readWhaleConfig();
	return cfg.onboarded === true || getDefaultModel() !== void 0;
}

export function markOnboarded() {
	return writeWhaleConfig({ onboarded: true });
}

function readYaml(path) {
	try {
		const doc = load(readFileSync(path, "utf8"));
		return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
	} catch {
		return {};
	}
}

function writeYaml(path, doc) {
	writeFileSync(path, dump(doc, { lineWidth: -1 }) + "\n");
}

/** Store one API key under its env-var name in `$DSH_HOME/.credentials.yaml`. */
export function storeCredential(envName, value) {
	const path = homePath(".credentials.yaml");
	const doc = readYaml(path);
	doc[envName] = value;
	writeYaml(path, doc);
}

/** Add/merge one `llm-pi-ai.providers.<provider>` route in `settings.yaml`. */
export function storePiAiProvider(provider, profile) {
	const path = homePath("settings.yaml");
	const doc = readYaml(path);
	const section = doc["llm-pi-ai"] ?? {};
	const providers = section.providers ?? {};
	providers[provider] = { ...(providers[provider] ?? {}), ...profile };
	section.providers = providers;
	doc["llm-pi-ai"] = section;
	writeYaml(path, doc);
}

/** Derive the conventional API-key env name for a provider id. */
export function providerApiKeyEnv(provider) {
	if (provider === "deepseek-official") return "DEEPSEEK_API_KEY";
	return `${provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
}

/** The fixed workspace root for gateway/channel agents (never the launch cwd). */
export function whaleWorkspace() {
	return process.env.WHALE_WORKSPACE ?? process.cwd();
}

/**
 * The workspace Whale agents work in. Resolution order: WHALE_WORKSPACE env >
 * persisted `workspace` in whale-config.json > `$DSH_HOME/workspace`.
 */
export function resolveWorkspaceDir() {
	const env = process.env.WHALE_WORKSPACE;
	if (typeof env === "string" && env !== "") return env;
	const persisted = readWhaleConfig().workspace;
	if (typeof persisted === "string" && persisted !== "") return persisted;
	return join(process.env.DSH_HOME ?? homedir(), "workspace");
}

/**
 * The file-access mode: "full" (danger-full-access, any disk read/write) or
 * "safe" (workspace-write). Persisted in whale-config.json; default safe.
 */
export function getAccessMode() {
	return readWhaleConfig().access === "full" ? "full" : "safe";
}

export function setAccessMode(mode) {
	return writeWhaleConfig({ access: mode });
}

/** Persist the workspace dir so it survives restarts (session inheritance). */
export function setWorkspaceDir(dir) {
	return writeWhaleConfig({ workspace: dir });
}
