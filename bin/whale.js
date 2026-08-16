#!/usr/bin/env node
// Whale npm entry point. Installs (or refreshes) the `whale` profile under
// $DSH_HOME/profiles/whale from this package, then boots DeepSeek Harness with
// `dsh --profile whale <args>`.
//
// DSH_HOME defaults to ~/.dsh when unset; everything else (workspace, skills
// root, WeChat config) derives from it, so the package is path-independent.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;

const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", "whale");
const whaleSrcDir = join(profileDir, "whale");
const marker = join(profileDir, ".whale-version");

/** Print the whale + WHALE welcome banner (art kept in scripts/whale-art.txt). */
function printWelcome() {
	let art = "";
	try {
		art = readFileSync(join(pkgRoot, "scripts", "whale-art.txt"), "utf8").replace(/\r?\n$/, "");
	} catch {
		/* art is optional */
	}
	const banner = [
		" __        ___   _    _    _     _____ ",
		" \\ \\      / / | | |  / \\  | |   | ____|",
		"  \\ \\ /\\ / /| |_| | / _ \\ | |   |  _|  ",
		"   \\ V  V / |  _  |/ ___ \\| |___| |___ ",
		"    \\_/\\_/  |_| |_/_/   \\_\\_____|_____|"
	];
	process.stdout.write("\n" + (art !== "" ? art + "\n\n" : "") + banner.join("\n") + "\n\n");
	process.stdout.write("  \u{1F433}  Whale \u2014 an AI agent on the DeepSeek Harness (DSH)\n\n");
	process.stdout.write("  首次使用：即将进入配置向导（选择模型服务商 -> 填写 API Key -> 选择默认模型）。\n\n");
}

/** True when this Whale install has never been onboarded (no whale-config.json). */
function isFirstRun() {
	try {
		const cfg = JSON.parse(readFileSync(join(dshHome, "whale-config.json"), "utf8"));
		return cfg.onboarded !== true && !(cfg.defaultModel && typeof cfg.defaultModel.provider === "string" && typeof cfg.defaultModel.model === "string");
	} catch {
		return true; // no config yet -> first run
	}
}

// `setup` is a bootstrap subcommand: it runs the repo's setup.ps1 (download
// the project, install deps, link the CLI, set env vars) and exits. It must
// not require DSH or an installed profile, so handle it before anything else.
if (process.argv[2] === "setup") {
	const setupScript = join(pkgRoot, "setup.ps1");
	if (!existsSync(setupScript)) {
		process.stderr.write(`whale: setup.ps1 not found in ${pkgRoot}\n`);
		process.exit(1);
	}
	const setupArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", setupScript, ...process.argv.slice(3)];
	const setupResult = spawnSync("powershell.exe", setupArgs, { stdio: "inherit", env: process.env, windowsHide: true });
	process.exit(setupResult.status ?? 1);
}

/**
 * Resolve dsh's real Node entry (lib/bin.js) sitting next to its .cmd shim in
 * the npm prefix. Spawning this directly with `process.execPath` avoids the
 * .cmd -> cmd.exe wrapper entirely, so no extra console window can flash when
 * whale is launched from a console-less context.
 */
function resolveDshJs(dshBin) {
	if (process.platform !== "win32" || !dshBin) return null;
	const candidate = join(dirname(dshBin), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
	return existsSync(candidate) ? candidate : null;
}

/**
 * Locate the `dsh` executable. On Windows it is a .cmd/.ps1 shim from a global
 * npm install, which child_process cannot spawn by bare name, so we resolve it
 * through PATH (honouring PATHEXT) ourselves.
 */
function findDsh() {
	const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	const candidates = process.platform === "win32"
		? pathExt.flatMap((ext) => [`dsh${ext.toLowerCase()}`, `dsh${ext}`])
		: ["dsh"];
	const seen = new Set();
	for (const dir of (process.env.PATH ?? "").split(";").filter(Boolean)) {
		for (const cand of candidates) {
			const full = join(dir, cand);
			if (seen.has(full) || !existsSync(full)) continue;
			seen.add(full);
			return full;
		}
	}
	return "dsh"; // fall back to bare name (Unix usually resolves directly)
}

/** Install the profile from this package. Safe to re-run; refreshes all files. */
function installProfile() {
	mkdirSync(profileDir, { recursive: true });
	// Profile plumbing (package.json / cordis.yml / cordis.patch.yml).
	cpSync(join(pkgRoot, "profile"), profileDir, { recursive: true });
	// Whale source: lib + skills + dev shims, mirroring the old layout where
	// cordis.patch.yml references ./whale/lib/*.js.
	rmSync(whaleSrcDir, { recursive: true, force: true });
	mkdirSync(whaleSrcDir, { recursive: true });
	cpSync(join(pkgRoot, "lib"), join(whaleSrcDir, "lib"), { recursive: true });
	cpSync(join(pkgRoot, "skills"), join(whaleSrcDir, "skills"), { recursive: true });
	cpSync(join(pkgRoot, "webui"), join(whaleSrcDir, "webui"), { recursive: true });
	mkdirSync(join(whaleSrcDir, "bin"), { recursive: true });
	cpSync(join(pkgRoot, "bin", "whale.ps1"), join(whaleSrcDir, "bin", "whale.ps1"));
	cpSync(join(pkgRoot, "bin", "whale.cmd"), join(whaleSrcDir, "bin", "whale.cmd"));
	writeFileSync(marker, pkgVersion, "utf8");
}

function readMarker() {
	try {
		return readFileSync(marker, "utf8").trim();
	} catch {
		return null;
	}
}

// (Re)install when missing or when the installed copy is from another version.
const installed = readMarker();
if (installed !== pkgVersion) installProfile();

// `dsh` must be on PATH before whale can boot. It ships as a dependency of this
// package, but detect it explicitly and fail with a clear hint rather than a
// cryptic spawn ENOENT.
const dshBin = findDsh();
if (dshBin === "dsh" && process.platform === "win32" && !existsSync(dshBin)) {
	process.stderr.write("whale: `dsh` (DeepSeek Harness) was not found on PATH.\n");
	process.stderr.write("  Install it with:  npm install -g @deepseek-ai/dsh\n");
	process.stderr.write("  Then reopen the terminal and run whale again.\n");
	process.exit(1);
}

// First run: print the welcome banner, then let bare `whale` fall through to
// the onboarding setup (the CLI routes an un-onboarded bare invocation into
// the model config wizard). Non-bare commands (doctor/help/etc.) don't print it.
const arg0 = process.argv[2];
const isBare = arg0 === undefined || arg0 === "setup" || arg0 === "models";
if (isFirstRun() && isBare) printWelcome();

// Resolve the workspace + file-access mode from whale-config.json so it is
// stable across restarts (session inheritance) and independent of the launch
// cwd. These are translated into the env vars dsh-base reads for its sandbox.
let whaleCfg = {};
try {
	whaleCfg = JSON.parse(readFileSync(join(dshHome, "whale-config.json"), "utf8"));
} catch {
	/* no config yet — defaults below */
}
const workspaceDir = process.env.WHALE_WORKSPACE
	?? (typeof whaleCfg.workspace === "string" && whaleCfg.workspace !== "" ? whaleCfg.workspace : join(dshHome, "workspace"));
const accessMode = whaleCfg.access === "full" ? "full" : "safe";
mkdirSync(workspaceDir, { recursive: true });

// Boot: dsh --profile whale <args>. WHALE_SKILLS points at the freshly
// installed shipped skills so cordis.patch.yml and lib/cli.js agree.
// Prefer spawning dsh's Node entry directly (no .cmd shim, no cmd.exe
// wrapper) with windowsHide: true, so launching from a console-less context
// never allocates a flashing conhost window. Fall back to the .cmd shim via
// shell: true (Windows cannot spawn a .cmd by bare name) — also hidden.
const dshJs = resolveDshJs(dshBin);
const bootArgs = ["--profile", "whale", ...process.argv.slice(2)];
const bootEnv = {
	...process.env,
	DSH_HOME: dshHome,
	WHALE_SKILLS: join(whaleSrcDir, "skills"),
	WHALE_WORKSPACE: workspaceDir,
	DSH_PERMISSION_MODE: accessMode === "full" ? "danger-full-access" : "workspace-write"
};
const result = dshJs !== null
	? spawnSync(process.execPath, [dshJs, ...bootArgs], {
		stdio: "inherit",
		windowsHide: true,
		cwd: workspaceDir,
		env: bootEnv
	  })
	: spawnSync(dshBin, bootArgs, {
		stdio: "inherit",
		shell: true,
		windowsHide: true,
		cwd: workspaceDir,
		env: bootEnv
	  });
process.exit(result.status ?? 1);
