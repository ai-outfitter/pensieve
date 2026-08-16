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

// Rows indexed before the derived columns existed are re-derived from the
// records in the store — the store is the truth, the index is a map. Every
// examined row is marked, so the sweep converges instead of re-reading the
// whole history on each boot. Runs after listen; the sink serves meanwhile.
void app.sink
	.backfillDerived()
	.then(({ examined, failed }) => {
		if (examined > 0) console.log(`  backfilled derived index fields on ${examined} rows`);
		if (failed > 0) console.warn(`  backfill could not read ${failed} records; they will retry next boot`);
	})
	.catch((error) => console.error("backfill failed", error));

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
