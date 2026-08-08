export { PensieveClient, type ClientOptions } from "./client.ts";
export { buildContext, clientOptions, type ContextOptions } from "./context.ts";
export { runHook, runStdinHook, type HookOptions, type NormalizedEvent } from "./hook-runner.ts";
export { CommitWatcher, MemorySegmentStore, type SegmentStore } from "./segment.ts";
export { SessionState } from "./state.ts";
export { INSTALL_SCOPES } from "./types.ts";
export type {
	CaptureProfile,
	CollectorContext,
	CommitInfo,
	EvidenceRecord,
	InstallScope,
	RecordKind,
} from "./types.ts";
