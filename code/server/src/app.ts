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

		if (path === "/v0/payloads/presign" && method === "POST") {
			if (!principal.canWrite) return problem(403, "principal may not write evidence");
			const body = (await request.json()) as Record<string, unknown>;
			if (typeof body.digest !== "string" || !/^[0-9a-f]{64}$/.test(body.digest)) {
				return problem(400, "digest must be a sha256 hex digest");
			}
			if (!Number.isSafeInteger(body.size) || (body.size as number) < 1) {
				return problem(400, "size must be a positive safe integer");
			}
			if (typeof body.content_type !== "string" || body.content_type.length < 1 || body.content_type.length > 255) {
				return problem(400, "content_type must be a non-empty string of at most 255 characters");
			}
			return Response.json(
				await sink.presignPayload({
					digest: body.digest,
					size: body.size as number,
					contentType: body.content_type,
				}),
				{ status: 201 },
			);
		}

		if (method === "POST") {
			const digest = payloadSealParam(path);
			if (digest) {
				if (!principal.canWrite) return problem(403, "principal may not write evidence");
				return Response.json(await sink.sealPayload(digest), { status: 201 });
			}
		}

		if (method === "GET") {
			const record = hexParam(path, "records", 64);
			if (record) {
				const found = await sink.readRecord(record);
				return found ? Response.json(found) : problem(404, "no such record");
			}
			const commit = hexParam(path, "commits", 40);
			if (commit) return Response.json(await sink.commitCoverage(commit));

			const patch = hexParam(path, "patches", 40);
			if (patch) return Response.json({ matches: sink.coverageByPatchId(patch) });
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

/** `/v0/<resource>/<hex id>`, or null when the path is not that shape. */
function hexParam(path: string, resource: string, length: number): string | null {
	const segments = path.split("/");
	if (segments.length !== 4 || segments[1] !== "v0" || segments[2] !== resource) return null;
	const id = segments[3];
	return id && id.length === length && /^[0-9a-f]+$/.test(id) ? id : null;
}

function payloadSealParam(path: string): string | null {
	const segments = path.split("/");
	if (segments.length !== 5 || segments[1] !== "v0" || segments[2] !== "payloads" || segments[4] !== "seal") {
		return null;
	}
	const digest = segments[3];
	return digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/** A rejection returns a typed error the collector can act on. SRV-001.11.5. */
function problem(status: number, detail: string): Response {
	return Response.json({ error: detail, status }, { status });
}
