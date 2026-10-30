/**
 * Credential-looking strings the publication profile refuses. EVL-001.6.2.
 * A pattern list cannot prove a bundle is clean; it catches the common shapes
 * that leak through copied traces and prompts.
 */
const PATTERNS: [string, RegExp][] = [
	["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
	["OpenAI-style API key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
	["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
	["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
	["bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/],
];

/** Names of the credential patterns that occur in `text`. */
export function findCredentials(text: string): string[] {
	return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
