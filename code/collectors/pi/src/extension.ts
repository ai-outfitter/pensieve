/**
 * Pi collector.
 *
 * Pi is the inverse of the other two harnesses. It exposes the deepest capture
 * surface of any of them — `before_provider_request` carries the model request
 * payload, and `tool_call` / `tool_result` carry full input and result content
 * — so it is the only harness on which `model-exchange` is not a declared gap.
 *
 * But Pi resolves configuration from `~/.pi/agent/` and project `.pi/` only.
 * There is no managed scope a session cannot override, and `--no-extensions`
 * disables extension discovery outright. So the authoritative install point is
 * a root-owned launcher wrapper, and this collector reports
 * `install_scope: "launcher"` rather than `"managed"` — a verifier reads that
 * and knows collection here was advisory. Reporting it as managed is
 * forbidden. CLC-001.2.4, CLC-001.2.7, CLC-001.8.3.
 */
// Relative rather than the @pensieve/collector-core workspace alias: this file
// is the repository's Pi-package entry, loaded from a bare `pi install` git
// checkout where no workspace install has run and the alias cannot resolve.
import {
	buildContext,
	clientOptions,
	CommitWatcher,
	MemorySegmentStore,
	PensieveClient,
} from "../../core/src/index.ts";

/** The subset of Pi's ExtensionAPI this collector uses. */
interface ExtensionAPI {
	on(event: string, handler: (event: unknown, context?: unknown) => unknown): void;
}

export default function pensieveCollector(pi: ExtensionAPI): void {
	const context = buildContext(
		{
			harness: "pi",
			harnessVersion: process.env.PI_VERSION ?? "unknown",
			eventSurface: "extension:in-process",
			// Pi is the only harness of the three that hands over the model request
			// payload, so nothing is unsupported here. CLC-001.7.2.
			unsupported: [],
			run: process.env.PENSIEVE_RUN ?? crypto.randomUUID(),
			cwd: process.cwd(),
		},
		process.env,
	);
	const client = new PensieveClient(clientOptions(process.env));
	// In-process, so segment state stays in memory; the command hooks pass a
	// file-backed store to the same watcher.
	const watcher = new CommitWatcher(context, client, new MemorySegmentStore());

	pi.on("session_start", async () => {
		await watcher.start();
		const record = watcher.base("session");
		const result = await client.submit({ ...record, argv: process.argv.slice(2) });
		watcher.note("session", result.digest);
	});

	// The model request payload. No other harness of the three exposes this.
	pi.on("before_provider_request", async (event) => {
		const payload = (event as { payload?: unknown }).payload;
		const record = watcher.base("model-exchange");
		const result = await client.submit({ ...record, direction: "request", payload });
		watcher.note("model-exchange", result.digest);
	});

	pi.on("after_provider_response", async (event) => {
		const response = event as { status?: number; headers?: Record<string, string> };
		// Status and headers only; the body is reconstructed from message events
		// rather than handed over. Recorded as what it is, not as a full exchange.
		const record = watcher.base("model-exchange");
		await client.submit({
			...record,
			direction: "response-metadata",
			status: response.status,
			headers: response.headers,
		});
	});

	pi.on("tool_result", async (event) => {
		const result = event as { toolName?: string; input?: unknown; content?: unknown; isError?: boolean };
		const record = watcher.base("tool-call");
		const stored = await client.submit({
			...record,
			tool_name: result.toolName,
			tool_input: result.input,
			tool_output: result.content,
			is_error: result.isError ?? false,
		});
		watcher.note("tool-call", stored.digest);
		// Observe git after every tool result rather than trusting the agent to
		// announce a commit. CLC-001.1.6.
		await watcher.check();
	});

	pi.on("session_shutdown", async () => {
		await watcher.check();
		await watcher.finish();
		// Deferred delivery for anything the sink refused while offline.
		await client.flush();
	});
}
