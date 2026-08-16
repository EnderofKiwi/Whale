// Whale command-line surface. This plugin owns the app's command grammar:
// it parses the launcher-provided `cmdlineArgs`, runs the invoked subcommand's
// action, and publishes the parsed invocation as the `whaleStartup` service for
// the runner plugins (`whale-cli`, `whale-gateway`) to consume.
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
import { isOnboarded } from "./config.js";

const name = "whale-startup";
const inject = ["cmdlineArgs"];

/** Service published by this plugin and injected by the runner plugins. */
export const WHALE_STARTUP_SERVICE = "whaleStartup";
export const WHALE_VERSION = "0.1.0";

function apply(ctx) {
	const program = new Command()
		.name("dsh --profile whale")
		.description("Whale — an AI agent on the DeepSeek Harness: terminal chat, gateway, and channels.")
		.version(WHALE_VERSION, "-V, --version", "output the version number")
		.helpOption("-h, --help", "show this help")
		.addHelpText("after", `
Examples:
  dsh --profile whale run "fix the lint errors"   answer one task and exit
  dsh --profile whale chat                        interactive terminal conversation (default)
  dsh --profile whale serve --port 4173           start the gateway + channels
  dsh --profile whale doctor                      print diagnostics
  dsh --profile whale status                      show channels and gateway status
  dsh --profile whale skills                      list available skills
`);

const provide = (value) => ctx.provide(WHALE_STARTUP_SERVICE, value);

	// Help text: prefer commander's own rendering, but never let a help
	// control-flow throw strand the runner without a whaleStartup service.
	function helpText() {
		try {
			const text = program.helpInformation();
			if (typeof text === "string" && text.length > 0) return text;
		} catch {
			/* fall through to the static text */
		}
		return `Usage: whale <command> [args]

Whale — an AI agent on the DeepSeek Harness.

Commands:
  run [task...]      Answer one task, print the final reply, and exit.
  chat               Start an interactive terminal conversation (default).
  serve [options]    Start the gateway (HTTP API) and the registered channels.
  doctor             Print runtime diagnostics.
  status             Show registered channels and gateway status.
  skills             List the available skills.
  models             Configure models interactively (choose provider -> API key -> model).
  version            Print the Whale version.
  help               Show this help.
`;
	}

	const runCmd = program.command("run")
		.description("Answer one task, print the final reply, and exit.")
		.argument("[task...]", "the task text; multiple words are joined by spaces");
	runCmd.action(() => {
		const task = runCmd.args.join(" ").trim();
		if (task === "") runCmd.error('error: a task is required, e.g. dsh --profile whale run "hello"');
		provide({ command: "run", opts: { task } });
	});

	const chatCmd = program.command("chat")
		.description("Start an interactive terminal conversation.");
	chatCmd.action(() => provide({ command: "chat", opts: {} }));

	const serveCmd = program.command("serve")
		.description("Start the gateway (HTTP API) and the registered channels.");
	serveCmd.option("-H, --host <host>", "bind host", "127.0.0.1");
	serveCmd.option("-p, --port <port>", "bind port", "4173");
	serveCmd.action(() => provide({
		command: "serve",
		opts: {
			host: serveCmd.opts().host,
			port: Number(serveCmd.opts().port)
		}
	}));

	const doctorCmd = program.command("doctor")
		.description("Print runtime diagnostics.");
	doctorCmd.action(() => provide({ command: "doctor", opts: {} }));

	const webUiCmd = program.command("web-ui")
		.description("Manage the local web UI + background gateway (silent, no terminal window).");
	const webUiStart = webUiCmd.command("start")
		.description("Start the gateway in the background and open the web UI.")
		.option("-p, --port <port>", "bind port", "4173");
	webUiStart.action(() => provide({ command: "web-ui", opts: { action: "start", port: Number(webUiStart.opts().port) } }));
	const webUiStop = webUiCmd.command("stop")
		.description("Stop the background gateway + web UI.")
		.option("-p, --port <port>", "bind port", "4173");
	webUiStop.action(() => provide({ command: "web-ui", opts: { action: "stop", port: Number(webUiStop.opts().port) } }));
	const webUiStatus = webUiCmd.command("status")
		.description("Show whether the background gateway is running.")
		.option("-p, --port <port>", "bind port", "4173");
	webUiStatus.action(() => provide({ command: "web-ui", opts: { action: "status", port: Number(webUiStatus.opts().port) } }));

	const statusCmd = program.command("status")
		.description("Show registered channels and gateway status.");
	statusCmd.action(() => provide({ command: "status", opts: {} }));

	const skillsCmd = program.command("skills")
		.description("Manage skills: list installed, or find popular/related skills via findskill.");
	skillsCmd.action(() => provide({ command: "skills", opts: { action: "menu" } }));
	skillsCmd.command("list")
		.description("List installed skills (shipped + user).")
		.action(() => provide({ command: "skills", opts: { action: "list" } }));
	skillsCmd.command("find")
		.description("Find skills via findskill: popular by default, or search by keywords.")
		.argument("[query...]", "search keywords (empty = popular skills)")
		.action((query) => provide({ command: "skills", opts: { action: "find", query: (query ?? []).join(" ") } }));
	skillsCmd.command("install")
		.description("Install a skill or a pack (a folder of skill folders) into the user skills dir.")
		.argument("<path>", "a SKILL.md file, a skill folder, or a folder of skill folders")
		.action((path) => provide({ command: "skills", opts: { action: "install", path } }));
	skillsCmd.command("uninstall")
		.description("Remove a user-installed skill by name.")
		.argument("<name>", "the skill name to remove")
		.action((name) => provide({ command: "skills", opts: { action: "uninstall", name } }));

	const versionCmd = program.command("version")
		.description("Print the Whale version.");
	versionCmd.action(() => provide({ command: "version", opts: {} }));

	const modelsCmd = program.command("models")
		.description("Configure models interactively: choose a provider, enter its API key, then pick a model.");
	modelsCmd.action(() => provide({ command: "models", opts: { action: "wizard" } }));
	modelsCmd.command("list")
		.description("List registered providers and their models.")
		.action(() => provide({ command: "models", opts: { action: "list" } }));
	modelsCmd.command("use")
		.description("Set the default model for future sessions.")
		.argument("<provider>", "provider id, e.g. deepseek-official")
		.argument("<model>", "model id, e.g. deepseek-v4-pro")
		.action((provider, model) => provide({ command: "models", opts: { action: "use", provider, model } }));
	modelsCmd.command("wechat")
		.description("Set the model used by the WeChat channel.")
		.argument("<model>", "model id, e.g. deepseek-v4-flash")
		.action((model) => provide({ command: "models", opts: { action: "wechat", model } }));

	// First-run onboarding: welcome + model config (same flow as `models`).
	const setupCmd = program.command("setup")
		.description("First-run welcome + configure your default model.");
	setupCmd.action(() => provide({ command: "setup", opts: {} }));

	// Workspace: show or set the directory agents work in (persisted).
	const workspaceCmd = program.command("workspace")
		.description("Show or set Whale's working directory (persisted; survives restart).");
	workspaceCmd.argument("[dir]", "new workspace directory (omitted = show current)")
		.action((dir) => provide({ command: "workspace", opts: { dir } }));

	// File access: safe (workspace-write) vs full (danger-full-access).
	const accessCmd = program.command("access")
		.description("Show or set file-access mode: safe (workspace only) / full (whole disk).");
	accessCmd.argument("[mode]", "safe | full (omitted = show current)")
		.option("--yes", "confirm the high-risk full mode without prompting")
		.action((mode) => provide({ command: "access", opts: { mode, yes: accessCmd.opts().yes ? "yes" : "" } }));

	// Default (no subcommand): "help" prints help, an unknown word prints an
	// error, and a bare invocation starts an interactive terminal conversation
	// — but on first run (not yet onboarded) it routes into setup instead.
	program.argument("[args...]", "arguments for the default command");
	program.action((args) => {
		if (args !== void 0 && args.length > 0) {
			if (args.length === 1 && args[0] === "help") {
				provide({ command: "help", opts: { text: helpText() } });
				return;
			}
			provide({ command: "unknown", opts: { text: args.join(" ") } });
			return;
		}
		provide({ command: isOnboarded() ? "chat" : "setup", opts: {} });
	});

	parseCmdline(ctx, program);
}

export { apply, inject, name };
