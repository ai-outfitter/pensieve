import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = fileURLToPath(new URL("../../../", import.meta.url));

describe("Pi collector runtime", () => {
	test("the Node-targeted bundle loads and invokes under node", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-pi-node-"));
		const output = join(root, "collectors", "pi");
		const extension = join(output, "extension.js");

		try {
			await mkdir(output, { recursive: true });
			await execFileAsync(
				process.execPath,
				[
					"build",
					"collectors/pi/src/extension.ts",
					"--target=node",
					"--format=esm",
					"--outfile",
					extension,
				],
				{ cwd: workspace },
			);
			await writeFile(join(output, "package.json"), '{"type":"module","main":"extension.js"}\n');

			const moduleUrl = pathToFileURL(extension).href;
			const invoke = `
				if (process.release.name !== "node") throw new Error("test did not run under node");
				const loaded = await import(${JSON.stringify(moduleUrl)});
				const events = [];
				loaded.default({ on(name) { events.push(name); } });
				console.log("invoked under node: " + events.join(","));
			`;
			// The point of this test is Node, so the binary is required — but which node
			// is not. An override keeps it runnable where bun is on PATH and node is not.
			const nodeBinary = process.env.PENSIEVE_TEST_NODE ?? "node";
			const { stdout, stderr } = await execFileAsync(nodeBinary, ["--input-type=module", "--eval", invoke]);

			expect(stderr).not.toContain("ReferenceError");
			expect(stdout).toContain("invoked under node: session_start");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("captures the complete Pi-visible session trace", async () => {
		// THIS TEST VALIDATES HARD REQUIREMENTS CLC-001.7.5 THROUGH CLC-001.7.7.
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENTS CHANGE.
		const spool = await mkdtemp(join(tmpdir(), "pensieve-pi-trace-"));
		const originalFetch = globalThis.fetch;
		const originalEnv = { ...process.env };
		const records: Array<Record<string, unknown>> = [];
		const handlers = new Map<string, (event: unknown) => Promise<unknown>>();

		try {
			process.env.PENSIEVE_SINK = "https://pensieve.test";
			process.env.PENSIEVE_TOKEN = "test-token";
			process.env.PENSIEVE_SPOOL = spool;
			process.env.PENSIEVE_RUN = "run-resident-1";
			process.env.PENSIEVE_IDENTITY = "agent:resident-1";
			process.env.PENSIEVE_INSTALL_SCOPE = "launcher";
			process.env.PENSIEVE_PROFILE = "resident-complete-trace";
			process.env.PENSIEVE_REQUIRED_CLASSES = "session,transcript,model-exchange,tool-call";
			globalThis.fetch = (async (_input, init) => {
				records.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return Response.json({ digest: records.length.toString(16).padStart(64, "0") }, { status: 201 });
			}) as typeof fetch;

			const loaded = await import(`./extension.ts?trace=${crypto.randomUUID()}`);
			loaded.default({
				on(name: string, handler: (event: unknown) => Promise<unknown>) {
					handlers.set(name, handler);
				},
			});

			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" });
			await handlers.get("before_agent_start")?.({
				type: "before_agent_start",
				prompt: "inspect the failing service",
				systemPrompt: "You are the resident engineer.",
				systemPromptOptions: { agent: "luce" },
			});
			await handlers.get("before_provider_request")?.({
				type: "before_provider_request",
				payload: { model: "test-model", messages: [{ role: "user", content: "inspect" }] },
			});
			await handlers.get("message_end")?.({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "check the logs first" },
						{ type: "text", text: "I will inspect the service." },
					],
				},
			});
			await handlers.get("tool_call")?.({
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "systemctl status example" },
			});
			await handlers.get("tool_result")?.({
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "systemctl status example" },
				content: [{ type: "text", text: "active" }],
				details: { exitCode: 0 },
				isError: false,
			});
			await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });

			expect(records).toEqual(expect.arrayContaining([
				expect.objectContaining({ kind: "session", run: "run-resident-1", identity: "agent:resident-1" }),
				expect.objectContaining({
					kind: "transcript",
					event: "before-agent-start",
					prompt: "inspect the failing service",
					system_prompt: "You are the resident engineer.",
				}),
				expect.objectContaining({
					kind: "transcript",
					event: "message-end",
					message: expect.objectContaining({ role: "assistant" }),
				}),
				expect.objectContaining({
					kind: "model-exchange",
					direction: "request",
					payload: expect.objectContaining({ model: "test-model" }),
				}),
				expect.objectContaining({
					kind: "tool-call",
					phase: "call",
					tool_call_id: "call-1",
					tool_input: { command: "systemctl status example" },
				}),
				expect.objectContaining({
					kind: "tool-call",
					phase: "result",
					tool_call_id: "call-1",
					tool_output: [{ type: "text", text: "active" }],
					tool_details: { exitCode: 0 },
					is_error: false,
				}),
			]));

			const terminal = records.find((record) => record.kind === "session" && record.terminal === true);
			expect(terminal).toMatchObject({
				captured: expect.arrayContaining(["session", "transcript", "model-exchange", "tool-call"]),
				capture: {
					profile: "resident-complete-trace",
					required: ["session", "transcript", "model-exchange", "tool-call"],
					captured: expect.arrayContaining(["session", "transcript", "model-exchange", "tool-call"]),
					gaps: [],
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
			for (const key of Object.keys(process.env)) {
				if (!(key in originalEnv)) delete process.env[key];
			}
			Object.assign(process.env, originalEnv);
			await rm(spool, { recursive: true, force: true });
		}
	});
});
