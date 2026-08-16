#!/usr/bin/env node
// Post-install note. Whale deliberately does NOT auto-launch any window:
// like other agents, installation only prints a reminder and the user starts
// whale themselves (`whale` / `whale chat`). The welcome banner and the
// first-run model wizard appear on that first manual run (bin/whale.js +
// lib/cli.js onboarding), never from npm itself.
//
// Only print the reminder for a *global* install: when whale-agent is pulled
// in as a dependency of another project, npm runs postinstall there too, and
// a "run whale" banner would be noise. npm exposes the current install mode
// to lifecycle scripts as npm_config_global=true.
const isGlobal = process.env.npm_config_global === "true" || process.env.npm_config_global === "1";
if (!isGlobal) process.exit(0);

process.stdout.write(
	"\n" +
	"  \u{1F433}  whale-agent 安装成功！\n" +
	"  ──────────────────────────────\n" +
	"  请输入  whale  并按回车，开始首次配置：\n" +
	"  选择模型服务商 -> 填写 API Key -> 选择默认模型\n" +
	"\n" +
	"  如果提示\u201C不是内部或外部命令\u201D，请【新开一个终端窗口】\n" +
	"  再输入 whale（npm 全局命令不会自动刷新已打开的窗口）。\n" +
	"\n"
);
