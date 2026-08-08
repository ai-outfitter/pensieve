export { PensieveClient, type ClientOptions } from "./client.ts";
export { buildContext, clientOptions, installScope, profileFor, type ContextOptions } from "./context.ts";
export { commitInfo, head, patchId } from "./git.ts";
export { CommitWatcher, Segment } from "./segment.ts";
export type {
	CaptureProfile,
	CollectorContext,
	CommitInfo,
	EvidenceRecord,
	InstallScope,
	RecordKind,
} from "./types.ts";
