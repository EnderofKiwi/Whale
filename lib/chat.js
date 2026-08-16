// Whale terminal chat: an interactive REPL that keeps ONE persistent agent
// session and streams each turn to the terminal. Exit with `/exit` (or
// Ctrl+C, which the launcher turns into a graceful shutdown).
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createWhaleAgent, submitText, lastAssistantText } from "./agent.js";

export async function runChat(ctx, exit) {
	await ctx.get("loader")?.await();
	const sessions = ctx.get("sessions");
	const agent = await createWhaleAgent(ctx);
	await agent.whenIdle();

	const rl = readline.createInterface({ input, output, terminal: input.isTTY });
	output.write("Whale terminal chat — type /exit or press Ctrl+C to leave.\n");

	const turn = async (text) => {
		const firstSeq = agent.session.seq;
		submitText(agent, text);
		output.write("\u2026\n");
		await agent.whenIdle();
		if (sessions !== void 0) await sessions.flush(agent.session);
		const reply = lastAssistantText(agent.session.events, firstSeq);
		output.write((reply || "(no reply)") + "\n");
	};

	while (true) {
		let line;
		try {
			line = await rl.question("whale> ");
		} catch {
			break; // EOF (Ctrl+D) or interface closed
		}
		const text = line.trim();
		if (text === "") continue;
		if (text === "/exit" || text === "/quit") break;
		try {
			await turn(text);
		} catch (error) {
			output.write(`whale: ${error?.message ?? String(error)}\n`);
		}
	}

	rl.close();
	if (sessions !== void 0) await sessions.flush(agent.session);
	exit(0);
}
