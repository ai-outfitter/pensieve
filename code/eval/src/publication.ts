/**
 * Credential-looking strings the publication profile refuses, in file
 * contents and in file paths. EVL-001.6.2.
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

/** Key names that hold secrets, compared lowercase with separators removed. EVL-001.6.4. */
const SECRET_KEYS = ["apikey", "token", "secret", "password", "passwd", "authorization", "privatekey"];

const isSecretKey = (key: string) => {
	const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return SECRET_KEYS.some((s) => k === s || k.endsWith(s));
};

/**
 * Field paths in a parsed JSON value whose key is secret-like and whose value
 * is a non-empty string. `maxOutputTokens` does not match; `access_token`,
 * `x-api-key`, and `Authorization` do. Iterative, so depth cannot overflow.
 */
export function findSecretKeys(value: unknown): string[] {
	const found: string[] = [];
	const stack: [unknown, string][] = [[value, ""]];
	while (stack.length > 0) {
		const [v, path] = stack.pop()!;
		if (typeof v !== "object" || v === null) continue;
		for (const [key, member] of Object.entries(v)) {
			const at = Array.isArray(v) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
			if (!Array.isArray(v) && isSecretKey(key) && typeof member === "string" && member.length > 0) found.push(at);
			stack.push([member, at]);
		}
	}
	return found.sort();
}
