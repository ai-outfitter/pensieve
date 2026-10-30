/**
 * @pensieve/eval — evaluation bundles (EVL-001), pure part.
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
export { isSafePath, MAX_DEPTH, MAX_MANIFEST_BYTES, validateManifest, validateBundleFiles, type BundleFiles } from "./validate.ts";
export { compareManifests, CHANGE_COVERS, type ComparisonReport, type CaseComparison, type ProvenanceField, type Transition } from "./compare.ts";
export { findCredentials, findSecretKeys } from "./publication.ts";
export { formatComparison, formatSummary, MODE_LABEL, summarize } from "./report.ts";
