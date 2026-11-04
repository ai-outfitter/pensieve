/**
 * @pensieve/eval — evaluation bundles (EVL-001) and agent records (EVL-002), pure part.
 *
 * Runs unchanged under Node, Bun, and Cloudflare Workers: no runtime imports,
 * hashing through Web Crypto. Filesystem access is in `./node.ts`.
 *
 * The package ships TypeScript source, not a build. Consumers load it through
 * a workspace or submodule path with Bun, tsx, Node's type stripping
 * (22.18+), or a bundler such as Wrangler's. The source uses erasable syntax only.
 */
export * from "./types.ts";
export { canonicalize, canonicalDigest, sha256Hex } from "./canonical.ts";
export { MAX_MANIFEST_BYTES, validateManifest, validateBundleFiles, type BundleFiles } from "./validate.ts";
export { compareManifests, type ComparisonReport, type CaseComparison, type ProvenanceField, type Transition } from "./compare.ts";
export { formatComparison, formatSummary } from "./report.ts";
export {
	BLOB_THRESHOLD_BYTES,
	CLIENT_KINDS,
	CONTEXT_KINDS,
	MAX_RECORD_BYTES,
	RECORD_EVIDENCE,
	RECORD_STANDARD,
	RECORD_STATUSES,
	TOOL_CALL_STATUSES,
	blobKey,
	blobRef,
	buildRecord,
	recordDigest,
	recordKey,
	splitBody,
	validateRecord,
	verifyRecordBlobs,
	type AgentRecord,
	type AgentRecordInput,
	type BlobRef,
	type BuiltRecord,
	type ClientKind,
	type ContextKind,
	type RecordEvidence,
	type RecordGap,
	type RecordReport,
	type RecordStatus,
	type ToolCall,
	type ToolCallStatus,
	type Usage,
} from "./record.ts";
