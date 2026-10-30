/**
 * @pensieve/eval — evaluation bundles (EVL-001), pure part.
 *
 * Runs unchanged under Node, Bun, and Cloudflare Workers: no runtime imports,
 * hashing through Web Crypto. Filesystem access is in `./node.ts`.
 */
export * from "./types.ts";
export { canonicalize, canonicalDigest, sha256Hex } from "./canonical.ts";
export { isSafePath, validateManifest, validateBundleFiles, type BundleFiles } from "./validate.ts";
export { compareManifests, CHANGE_COVERS, PROVENANCE_FIELDS, type ComparisonReport, type CaseComparison, type ProvenanceField, type Transition } from "./compare.ts";
export { findCredentials } from "./publication.ts";
export { formatComparison, formatSummary, MODE_LABEL, summarize } from "./report.ts";
