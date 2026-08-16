import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = await createApp(config);

const server = Bun.serve({
	port: config.port,
	hostname: "0.0.0.0",
	fetch: (request) => app.handle(request),
	error(error) {
		console.error(error);
		return Response.json({ error: "internal error", status: 500 }, { status: 500 });
	},
});

// Rows indexed before the harness column existed hold NULL; re-derive them
// from the records in the store so a harness filter sees the whole history.
// Runs after listen — the sink serves while it backfills.
void app.sink.backfillHarness().then((updated) => {
	if (updated > 0) console.log(`  backfilled harness on ${updated} index rows`);
});

const identity = app.sink.identity;
console.log(`pensieve sink listening on http://${server.hostname}:${server.port}`);
console.log(`  sink        ${identity.id} (key ${identity.key_id})`);
console.log(`  store       ${config.store.kind}`);
console.log(`  conforming  ${app.sink.conforming}`);
if (!app.sink.conforming) {
	// SRV-001.1.6: say so loudly rather than let a demo look audited.
	console.warn(
		"  WARNING: this deployment is non-conforming. Records it accepts are marked non-conforming.",
	);
}
