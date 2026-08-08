import { authenticate } from "./auth.ts";
import type { Config } from "./config.ts";
import { RecordIndex } from "./db.ts";
import { Signer } from "./identity.ts";
import { RecordError } from "./records.ts";
import { AuthError, Sink } from "./sink.ts";
import { FilesystemStore } from "./store/fs.ts";
import { S3Store } from "./store/s3.ts";
import { StoreError, type Store } from "./store/types.ts";

export interface App {
	sink: Sink;
	config: Config;
	handle(request: Request): Promise<Response>;
}

export async function createApp(config: Config): Promise<App> {
	const store: Store =
		config.store.kind === "s3"
			? new S3Store({
					endpoint: config.store.endpoint,
					bucket: config.store.bucket,
					region: config.store.region,
					accessKeyId: config.store.accessKeyId,
					secretAccessKey: config.store.secretAccessKey,
				})
			: new FilesystemStore(config.store.root);

	const signer = await Signer.create({ id: config.sinkId, privateKeyPkcs8Base64: config.signingKey });
	const index = new RecordIndex(config.indexPath);
	const sink = new Sink(store, signer, index, config.retentionFloorDays);

	async function route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		if (path === "/health") {
			return Response.json({ ok: true, conforming: sink.conforming, store: store.kind });
		}

		// The verification key a caller pins, so it can reach its own conclusion.
		// SRV-001.1.3, SRV-001.10.4.
		if (path === "/v0/identity") {
			return Response.json({ ...sink.identity, conforming: sink.conforming, mechanism: store.kind });
		}

		const principal = authenticate(request, config.devAuth);

		if (path === "/v0/records" && method === "POST") {
			const stored = await sink.ingest(await request.json(), principal);
			return Response.json(
				{ digest: stored.digest, statement: stored.statement },
				{ status: 201 },
			);
		}

		if (path === "/v0/payloads" && method === "POST") {
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (bytes.byteLength === 0) return problem(400, "payload body is empty");
			if (!principal.canWrite) return problem(403, "principal may not write evidence");
			const result = await sink.putPayload(
				bytes,
				request.headers.get("content-type") ?? "application/octet-stream",
			);
			return Response.json(result, { status: 201 });
		}

		const recordMatch = /^\/v0\/records\/([0-9a-f]{64})$/.exec(path);
		if (recordMatch?.[1] && method === "GET") {
			const record = await sink.readRecord(recordMatch[1]);
			return record ? Response.json(record) : problem(404, "no such record");
		}

		const commitMatch = /^\/v0\/commits\/([0-9a-f]{40})$/.exec(path);
		if (commitMatch?.[1] && method === "GET") {
			return Response.json(await sink.commitCoverage(commitMatch[1]));
		}

		const patchMatch = /^\/v0\/patches\/([0-9a-f]{40})$/.exec(path);
		if (patchMatch?.[1] && method === "GET") {
			return Response.json({ matches: sink.coverageByPatchId(patchMatch[1]) });
		}

		if (path === "/v0/coverage" && method === "POST") {
			const body = (await request.json()) as { commits?: unknown };
			if (!Array.isArray(body.commits)) return problem(400, "body must carry a commits array");
			return Response.json(await sink.rangeCoverage(body.commits as string[]));
		}

		if (path === "/v0/findings" && method === "GET") {
			return Response.json({ findings: sink.findings() });
		}

		return problem(404, `no route for ${method} ${path}`);
	}

	return {
		sink,
		config,
		async handle(request: Request): Promise<Response> {
			try {
				return await route(request);
			} catch (error) {
				if (error instanceof AuthError) return problem(error.status, error.message);
				if (error instanceof RecordError) return problem(error.status, error.message);
				if (error instanceof StoreError) return problem(error.status, error.message);
				console.error(error);
				return problem(500, "internal error");
			}
		},
	};
}

/** A rejection returns a typed error the collector can act on. SRV-001.11.5. */
function problem(status: number, detail: string): Response {
	return Response.json({ error: detail, status }, { status });
}
