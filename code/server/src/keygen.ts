/**
 * Print a fresh Ed25519 signing key for the sink, PKCS#8 base64.
 *
 * Without one, the sink runs unattested: it signs nothing and marks every
 * record it accepts non-conforming, so a demo stack can never look audited.
 * SRV-001.1.6.
 *
 *   bun run src/keygen.ts
 *   PENSIEVE_SIGNING_KEY=<output> bun run src/index.ts
 */
const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
	"sign",
	"verify",
])) as unknown as CryptoKeyPair;

const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
console.log(btoa(String.fromCharCode(...pkcs8)));
