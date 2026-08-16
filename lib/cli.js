// Whale CLI runner: dispatches the parsed `whaleStartup` invocation to the
// right surface. `run` drives one task to quiescence and prints the reply
// (mirroring dsh-headless); `chat` is the interactive terminal loop; `serve`
// is handled by `whale-gateway`; the rest are read-only diagnostics.
import { readdirSync, statSync, readFileSync, mkdirSync, cpSync, rmSync, existsSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { spawn, exec } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { WHALE_STARTUP_SERVICE, WHALE_VERSION } from "./startup.js";
import { createWhaleAgent, submitText, lastAssistantText } from "./agent.js";
import { runChat } from "./chat.js";
import { WHALE_CHANNELS_SERVICE } from "./channels.js";
import { getDefaultModel, getWechatModel, writeWhaleConfig, storeCredential, storePiAiProvider, providerApiKeyEnv, isOnboarded, markOnboarded, resolveWorkspaceDir, setWorkspaceDir, getAccessMode, setAccessMode } from "./config.js";

const name = "whale-cli";
const inject = [WHALE_STARTUP_SERVICE];

async function runOneShot(ctx, task) {
	await ctx.get("loader")?.await();
	const sessions = ctx.get("sessions");
	const agent = await createWhaleAgent(ctx);
	await agent.whenIdle();
	const firstSeq = agent.session.seq;
	submitText(agent, task);
	await agent.whenIdle();
	if (sessions !== void 0) await sessions.flush(agent.session);
	const text = lastAssistantText(agent.session.events, firstSeq);
	process.stdout.write((text ?? "") + "\n");
}

function runDoctor(ctx) {
	const lines = [];
	lines.push(`whale ${WHALE_VERSION}`);
	lines.push(`services: agents=${statusOf(ctx, "agents")} sessions=${statusOf(ctx, "sessions")} agentDefaultModel=${statusOf(ctx, "agentDefaultModel")} loader=${statusOf(ctx, "loader")} channels=${statusOf(ctx, WHALE_CHANNELS_SERVICE)} llm=${statusOf(ctx, "llm")}`);
	// The effective default model is the whale-config.json override when set;
	// otherwise it falls back to the settings-backed agentDefaultModel pin.
	// This mirrors resolveSelection() in agent.js, so `doctor` never lies about
	// which model a run/chat/gateway turn will actually use.
	const whaleDefault = getDefaultModel();
	if (whaleDefault !== void 0) {
		lines.push(`model: ${whaleDefault.provider}/${whaleDefault.model} (whale-config)`);
	} else {
		const defaultModel = ctx.get("agentDefaultModel");
		if (defaultModel !== void 0) {
			try {
				const selection = defaultModel.currentSelection();
				lines.push(`model: ${selection.provider}/${selection.model} (settings)`);
			} catch (error) {
				lines.push(`model: <unavailable: ${error?.message ?? String(error)}>`);
			}
		} else {
			lines.push("model: <unavailable>");
		}
	}
	lines.push(`cwd: ${process.cwd()}`);
	process.stdout.write(lines.join("\n") + "\n");
}

function runStatus(ctx) {
	const channels = ctx.get(WHALE_CHANNELS_SERVICE);
	const list = channels?.list?.() ?? [];
	process.stdout.write(`whale ${WHALE_VERSION}\n`);
	process.stdout.write(`channels (${list.length}):\n`);
	if (list.length === 0) process.stdout.write("  (none registered)\n");
	for (const channel of list) process.stdout.write(`  - ${channel.id} [${channel.status ?? "unknown"}]\n`);
}

function runSkillsList() {
	const found = [];
	for (const root of skillRoots()) {
		try {
			for (const entry of readdirSync(root.dir).sort()) {
				const full = join(root.dir, entry);
				let skillFile;
				if (statSync(full).isDirectory()) skillFile = join(full, "SKILL.md");
				else if (entry.endsWith(".md")) skillFile = full;
				if (skillFile === void 0) continue;
				try {
					const raw = readFileSync(skillFile, "utf8");
					const name = skillName(raw) ?? entry.replace(/\.md$/, "");
					found.push({ name, label: root.label, dir: root.dir });
				} catch {
					/* ignore unreadable skill files */
				}
			}
		} catch {
			/* root may not exist yet */
		}
	}
	process.stdout.write("已安装的 skill:\n");
	if (found.length === 0) process.stdout.write("  (none)\n");
	for (const skill of found) {
		process.stdout.write(`  - ${skill.name}  [${skill.label}]  (${skill.dir})\n`);
	}
}

/**
 * findskill-style discovery, implemented locally: search GitHub for SKILL.md
 * repos and rank by star count (findskill's own ranking signal). No external
 * registry dependency. Set GITHUB_TOKEN to raise the anonymous rate limit.
 */
async function runSkillsFind(query) {
	const q = (query ?? "").trim();
	const searchQuery = q === "" ? "SKILL.md" : `${q} SKILL.md`;
	const token = process.env.GITHUB_TOKEN ?? "";
	const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&order=desc&per_page=10`;
	const headers = {
		"Accept": "application/vnd.github+json",
		"User-Agent": "whale-skill-finder",
		...(token !== "" ? { "Authorization": `Bearer ${token}` } : {})
	};
	let data;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		try {
			const res = await fetch(url, { headers, signal: controller.signal });
			if (res.status === 403 || res.status === 429) throw new Error("GitHub API 限流/禁止（匿名搜索每小时仅 10 次），请设 GITHUB_TOKEN");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = await res.json();
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		const reason = error?.name === "AbortError" ? "连接超时" : (error?.message ?? String(error));
		process.stderr.write(`whale: 搜索 skill 失败: ${reason}\n`);
		process.stderr.write("  当前网络无法访问 GitHub 搜索 API（可能被墙，或本机代理/hosts 把 api.github.com 指向了本地）。可选：\n");
		process.stderr.write("    - 开启/修复代理或 VPN 后重试；\n");
		process.stderr.write("    - 设 GITHUB_TOKEN 提高限额并走认证；\n");
		process.stderr.write("    - 改用本地安装：whale skills install <路径>\n");
		return;
	}
	const items = data.items ?? [];
	if (items.length === 0) {
		process.stdout.write(q === "" ? "(没有找到热门 skill 仓库)\n" : `没有找到与 "${q}" 相关的 skill 仓库\n`);
		return;
	}
	const total = data.total_count ?? items.length;
	process.stdout.write(q === "" ? `热门 skill 仓库（GitHub 按 star 排序，共 ${total}）:\n` : `与 "${q}" 相关的 skill 仓库（按 star，共 ${total}）:\n`);
	for (const repo of items) {
		const stars = repo.stargazers_count !== void 0 && repo.stargazers_count !== null ? `★${repo.stargazers_count}` : "";
		process.stdout.write(`  ${repo.full_name}${stars ? `  ${stars}` : ""}\n`);
		if (repo.description) process.stdout.write(`    ${repo.description}\n`);
		if (repo.html_url) process.stdout.write(`    ${repo.html_url}\n`);
	}
}

async function runSkillsMenu() {
	if (!input.isTTY) {
		// Piped/non-interactive stdin: the two-option menu needs a terminal.
		// Fall back to listing so `whale skills` stays script-safe.
		runSkillsList();
		return;
	}
	const rl = readline.createInterface({ input, output, terminal: true });
	try {
		output.write("whale skills:\n");
		output.write("  1) 显示已安装的 skill\n");
		output.write("  2) 用 findskill 查找 skill（默认热门，可输入关键词检索）\n");
		const choice = (await rl.question("请选择 (1/2): ")).trim();
		if (choice === "2") {
			const query = (await rl.question("检索关键词（回车 = 热门）: ")).trim();
			await runSkillsFind(query);
		} else {
			runSkillsList();
		}
	} finally {
		rl.close();
	}
}

async function runSkills(ctx, opts = {}) {
	switch (opts.action) {
		case "install":
			runSkillsInstall(opts.path);
			return;
		case "uninstall":
			runSkillsUninstall(opts.name);
			return;
		case "find":
			await runSkillsFind(opts.query);
			return;
		case "list":
			runSkillsList();
			return;
		case "menu":
		default:
			await runSkillsMenu();
			return;
	}
}

function statusOf(ctx, service) {
	return ctx.get(service) !== void 0 ? "ok" : "missing";
}

async function runModelsWizard(ctx) {
	await ctx.get("loader")?.await();
	const llm = ctx.get("llm");
	if (llm === void 0) {
		process.stdout.write("whale: llm service unavailable\n");
		return;
	}
	const providers = llm.listConfigurableProviders();
	if (providers.length === 0) {
		process.stdout.write("(no configurable providers registered)\n");
		return;
	}

	// First-run onboarding prints a short welcome header, then reuses the same
	// interactive provider -> API key -> model flow as `whale models`.
	process.stdout.write("\n  \u{1F433}  Welcome to Whale \u2014 let's set up your default model.\n\n");
	const rl = readline.createInterface({ input, output, terminal: input.isTTY });
	output.write("Choose a provider:\n");
	providers.forEach((p, i) => output.write(`  ${i + 1}. ${p.displayName} [${p.provider}]\n`));
	const providerChoice = (await rl.question("Provider number: ")).trim();
	const entry = providers[Number(providerChoice) - 1];
	if (entry === void 0) {
		output.write("invalid provider choice\n");
		rl.close();
		return;
	}

	const apiKey = (await rl.question(`API key for ${entry.displayName} (blank = keep existing): `)).trim();
	const baseURL = (await rl.question("Base URL (blank = use provider default): ")).trim() || void 0;

	let models;
	try {
		models = await llm.discoverModels(entry.settingsNs, {
			provider: entry.provider,
			...(baseURL === void 0 ? {} : { baseURL }),
			...(apiKey === "" ? {} : { apiKey })
		});
	} catch (discoverError) {
		// Fall back to a registered adapter's static catalog (e.g. deepseek-official).
		try {
			models = await llm.listModels(entry.provider);
		} catch {
			output.write(`discovery failed: ${discoverError?.message ?? String(discoverError)}\n`);
			rl.close();
			return;
		}
	}

	if (models.length === 0) {
		output.write("no models discovered for this provider\n");
		rl.close();
		return;
	}
	output.write(`Models for ${entry.displayName}:\n`);
	models.forEach((m, i) => output.write(`  ${i + 1}. ${m.id}${m.name ? ` (${m.name})` : ""}\n`));
	const modelChoice = (await rl.question("Model number: ")).trim();
	const model = models[Number(modelChoice) - 1];
	if (model === void 0) {
		output.write("invalid model choice\n");
		rl.close();
		return;
	}

	const envName = providerApiKeyEnv(entry.provider);
	if (apiKey !== "") storeCredential(envName, apiKey);
	if (entry.settingsNs === "llm-pi-ai") {
		storePiAiProvider(entry.provider, {
			apiKeyEnv: envName,
			...(baseURL === void 0 ? {} : { baseURL })
		});
	}
	writeWhaleConfig({ defaultModel: { provider: entry.provider, model: model.id } });
	markOnboarded();
	output.write(`Done. Default model: ${entry.provider}/${model.id} (restart whale serve to apply).\n`);
	output.write("Whale is ready \u2014 try: whale chat, whale run \"hello\", or whale web-ui start\n");
	rl.close();
}

async function runModels(ctx, opts) {
	const llm = ctx.get("llm");
	const defaultModel = ctx.get("agentDefaultModel");

	if (opts.action === "wizard") {
		await runModelsWizard(ctx);
		return;
	}

	if (opts.action === "list") {
		if (llm === void 0) {
			process.stdout.write("whale: llm service unavailable\n");
			return;
		}
		const current = getDefaultModel() ?? defaultModel?.currentSelection?.() ?? { provider: "", model: "" };
		const wechatModel = getWechatModel("deepseek-v4-flash");
		const providers = llm.listProviders();
		if (providers.length === 0) {
			process.stdout.write("(no model providers registered)\n");
			return;
		}
		for (const provider of providers) {
			process.stdout.write(`${provider.name ?? provider.id} [${provider.id}]:\n`);
			let models;
			try {
				models = await llm.listModels(provider.id);
			} catch (error) {
				process.stdout.write(`  <unavailable: ${error?.message ?? String(error)}>\n`);
				continue;
			}
			for (const model of models) {
				const marks = [];
				if (provider.id === current.provider && model.id === current.model) marks.push("default");
				if (model.id === wechatModel) marks.push("wechat");
				process.stdout.write(`  - ${model.id}${marks.length > 0 ? `  [${marks.join(", ")}]` : ""}\n`);
			}
		}
		return;
	}

	if (opts.action === "use") {
		writeWhaleConfig({ defaultModel: { provider: opts.provider, model: opts.model } });
		process.stdout.write(`default model set to ${opts.provider}/${opts.model}\n`);
		return;
	}

	if (opts.action === "wechat") {
		writeWhaleConfig({ wechatModel: opts.model });
		process.stdout.write(`wechat model set to ${opts.model} (restart whale serve to apply)\n`);
		return;
	}

	process.stdout.write(`whale: unknown models action ${JSON.stringify(opts.action)}\n`);
}

/** Shipped skills (bundled with the source) — read-only. */
function shippedSkillDir() {
	return process.env.WHALE_SKILLS ?? join(process.env.DSH_HOME ?? ".", "profiles", "whale", "whale", "skills");
}

/** User-installed skills live in `$DSH_HOME/skills` and survive source sync. */
function userSkillDir() {
	return join(process.env.DSH_HOME ?? ".", "skills");
}

function skillRoots() {
	return [
		{ dir: userSkillDir(), label: "user" },
		{ dir: shippedSkillDir(), label: "shipped" }
	];
}

/** Read a skill folder's frontmatter name, falling back to its basename. */
function skillNameFromDir(dir) {
	try {
		const name = skillName(readFileSync(join(dir, "SKILL.md"), "utf8"));
		if (name !== void 0) return name;
	} catch {
		/* fall through to basename */
	}
	return basename(dir);
}

/** Copy one skill (file or folder) into place, replacing any existing copy. */
function copySkill(src, dest) {
	rmSync(dest, { recursive: true, force: true });
	cpSync(src, dest, { recursive: true });
	return dest;
}

/**
 * Install a single skill or a whole "合集" (a folder of skill folders) into the
 * user skills dir. Accepts: a SKILL.md file, one skill folder, or a pack folder
 * whose subfolders each contain a SKILL.md.
 */
function runSkillsInstall(srcPath) {
	const src = resolve(srcPath);
	if (!existsSync(src)) {
		process.stderr.write(`whale: no such skill path: ${srcPath}\n`);
		return;
	}
	const user = userSkillDir();
	mkdirSync(user, { recursive: true });
	const installed = [];
	if (statSync(src).isFile() && src.endsWith(".md")) {
		installed.push(copySkill(src, join(user, basename(src))));
	} else if (statSync(src).isDirectory()) {
		if (existsSync(join(src, "SKILL.md"))) {
			installed.push(copySkill(src, join(user, skillNameFromDir(src))));
		} else {
			for (const entry of readdirSync(src).sort()) {
				const sub = join(src, entry);
				if (!statSync(sub).isDirectory()) continue;
				if (!existsSync(join(sub, "SKILL.md"))) continue;
				installed.push(copySkill(sub, join(user, skillNameFromDir(sub))));
			}
		}
	}
	if (installed.length === 0) {
		process.stderr.write(`whale: nothing installable at ${srcPath} (need a SKILL.md file, a skill folder, or a folder of skill folders)\n`);
		return;
	}
	process.stdout.write(`installed ${installed.length} skill(s) into ${user}:\n`);
	for (const path of installed) process.stdout.write(`  - ${path}\n`);
}

function runSkillsUninstall(name) {
	const user = userSkillDir();
	const dir = join(user, name);
	const md = join(user, `${name}.md`);
	let removed;
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
		removed = dir;
	} else if (existsSync(md)) {
		rmSync(md, { force: true });
		removed = md;
	}
	if (removed === void 0) {
		process.stderr.write(`whale: no user-installed skill named ${JSON.stringify(name)}\n`);
		return;
	}
	process.stdout.write(`removed ${removed}\n`);
}

function webUiStateFile() {
	return join(process.env.DSH_HOME ?? ".", "whale-web-ui.json");
}

function readWebUiState() {
	try {
		const state = JSON.parse(readFileSync(webUiStateFile(), "utf8"));
		if (state && Number.isInteger(state.pid) && state.pid > 0) return state;
	} catch {
		/* no state yet */
	}
	return void 0;
}

function isProcessRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function openBrowser(url) {
	const cmd = process.platform === "win32"
		? `start "" "${url}"`
		: process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
	exec(cmd, (error) => {
		if (error) process.stderr.write(`whale: 打开浏览器失败: ${error?.message ?? String(error)}\n`);
	});
}

async function waitForHealth(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}health`);
			if (res.ok) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

async function runWebUi(ctx, opts) {
	const port = Number(opts.port) || 4173;
	const url = `http://127.0.0.1:${port}/`;

	if (opts.action === "stop") {
		const state = readWebUiState();
		if (state !== void 0 && isProcessRunning(state.pid)) {
			try {
				process.kill(state.pid, "SIGTERM");
			} catch (error) {
				process.stderr.write(`whale web-ui: 停止失败: ${error?.message ?? String(error)}\n`);
			}
			try { rmSync(webUiStateFile(), { force: true }); } catch { /* ignore */ }
			process.stdout.write(`whale web-ui: 已停止 (PID ${state.pid})。\n`);
			return;
		}
		try { rmSync(webUiStateFile(), { force: true }); } catch { /* ignore */ }
		if (await waitForHealth(url, 600)) {
			process.stdout.write(`whale web-ui: 端口 ${port} 有 serve 在跑，但不是 web-ui 托管的（无 PID 记录），请手动停止。\n`);
		} else {
			process.stdout.write("whale web-ui: 后台 gateway 未在运行。\n");
		}
		return;
	}

	if (opts.action === "status") {
		const state = readWebUiState();
		const managed = state !== void 0 && isProcessRunning(state.pid);
		const serving = await waitForHealth(url, 800);
		if (serving) {
			process.stdout.write(`whale web-ui: 运行中 ${url} (${managed ? `托管 PID ${state.pid}` : "手动启动，非 web-ui 托管"})\n`);
		} else if (managed) {
			process.stdout.write(`whale web-ui: 进程存在但端口 ${port} 未响应 (PID ${state.pid})\n`);
		} else {
			process.stdout.write("whale web-ui: 未运行。\n");
		}
		return;
	}

	// action === "start"
	// Something already serving this port (managed or manual)? Just open it.
	if (await waitForHealth(url, 800)) {
		process.stdout.write(`whale web-ui: gateway 已在 ${url} 运行，直接打开。\n`);
		openBrowser(url);
		return;
	}

	const dshBin = process.argv[1];
	const logFile = join(process.env.DSH_HOME ?? ".", "whale-web-ui.log");
	let logFd = -1;
	try {
		logFd = openSync(logFile, "a");
	} catch {
		logFd = -1;
	}
	const child = spawn(process.execPath, [dshBin, "--profile", "whale", "serve", "--port", String(port)], {
		detached: true,
		windowsHide: true,
		stdio: logFd >= 0 ? ["ignore", logFd, logFd] : "ignore",
		env: {
			...process.env,
			DSH_PERMISSION_MODE: "danger-full-access",
			WHALE_WORKSPACE: process.env.WHALE_WORKSPACE ?? resolveWorkspaceDir()
		}
	});
	child.unref();
	if (logFd >= 0) {
		try { closeSync(logFd); } catch { /* ignore */ }
	}
	writeFileSync(webUiStateFile(), JSON.stringify({ pid: child.pid, port }) + "\n");
	process.stdout.write(`whale web-ui: 正在后台静默启动 gateway (PID ${child.pid}, 端口 ${port})…\n`);

	if (await waitForHealth(url, 15000)) {
		process.stdout.write(`whale web-ui: 就绪 ${url}\n`);
		openBrowser(url);
	} else {
		process.stderr.write(`whale web-ui: gateway 15s 内未就绪，请查看 ${logFile} 或运行 whale serve --port ${port} 排查。\n`);
	}
}

function skillName(raw) {
	if (raw.slice(0, 3) !== "---") return void 0;
	for (const line of raw.split("\n")) {
		const match = /^\s*name\s*:\s*(.+?)\s*$/.exec(line);
		if (match) return match[1].replace(/['"]/g, "");
	}
	return void 0;
}

/** `whale workspace` (show) / `whale workspace <dir>` (set, persisted). */
function runWorkspace(opts) {
	if (opts.dir !== void 0 && opts.dir !== "") {
		const dir = resolve(opts.dir);
		mkdirSync(dir, { recursive: true });
		setWorkspaceDir(dir);
		process.stdout.write(`工作区已设为: ${dir}\n`);
		process.stdout.write("（下次运行 whale 生效；重启 whale serve / web-ui 以应用）\n");
		return;
	}
	process.stdout.write(`当前工作区: ${resolveWorkspaceDir()}\n`);
}

/** `whale access` (show) / `whale access safe|full`. */
function runAccess(opts) {
	if (opts.mode === undefined) {
		process.stdout.write(`当前文件访问模式: ${getAccessMode() === "full" ? "full（任意读写整个磁盘）" : "safe（仅工作区内）"}\n`);
		return;
	}
	if (opts.mode === "safe") {
		setAccessMode("safe");
		process.stdout.write("文件访问模式已设为 safe（仅工作区内读写）。\n");
		return;
	}
	if (opts.mode === "full") {
		const confirmed = (opts.yes ?? "").toLowerCase() === "yes";
		if (!confirmed) {
			process.stderr.write("\n  ⚠️  高风险操作\n");
			process.stderr.write("  开启 full 访问后，Whale 可以读写你整台电脑的任意文件（包括删除）。\n");
			process.stderr.write("  仅在你完全信任、且理解风险时启用。\n\n");
			process.stderr.write("  确认开启？输入 `whale access full --yes`（或 yes）来启用。\n");
			return;
		}
		setAccessMode("full");
		process.stdout.write("文件访问模式已设为 full（任意读写整个磁盘）。\n");
		process.stdout.write("⚠️  下次运行 whale 生效；请确认这是你想要的高权限模式。\n");
		return;
	}
	process.stderr.write(`whale access: 未知模式 ${JSON.stringify(opts.mode)}（可用 safe / full）\n`);
}

function apply(ctx) {
	const startup = ctx.get(WHALE_STARTUP_SERVICE);
	const exit = ctx.get("appExit");
	const { command, opts } = startup;

	const dispatch = async () => {
		switch (command) {
			case "run":
				await runOneShot(ctx, opts.task);
				exit(0);
				break;
			case "chat":
				await runChat(ctx, exit);
				break;
			case "setup":
				await runModels(ctx, { action: "wizard" });
				exit(0);
				break;
			case "doctor":
				runDoctor(ctx);
				exit(0);
				break;
			case "status":
				runStatus(ctx);
				exit(0);
				break;
			case "skills":
				await runSkills(ctx, opts);
				exit(0);
				break;
			case "web-ui":
				await runWebUi(ctx, opts);
				exit(0);
				break;
			case "version":
				process.stdout.write(`whale ${WHALE_VERSION}\n`);
				exit(0);
				break;
			case "help":
				process.stdout.write(opts.text ?? "");
				exit(0);
				break;
			case "unknown":
				process.stderr.write(`whale: unknown command ${JSON.stringify(opts.text)} (run 'whale help')\n`);
				exit(1);
				break;
			case "models":
				await runModels(ctx, opts);
				exit(0);
				break;
			case "workspace":
				runWorkspace(opts);
				exit(0);
				break;
			case "access":
				runAccess(opts);
				exit(0);
				break;
			case "serve":
				// Handled by whale-gateway, which also injects whaleStartup.
				break;
			default:
				process.stderr.write(`whale: unknown command ${JSON.stringify(command)}\n`);
				exit(1);
		}
	};

	dispatch().catch((error) => {
		process.stderr.write(`whale: ${error?.message ?? String(error)}\n`);
		exit(1);
	});
}

export { apply, inject, name };
