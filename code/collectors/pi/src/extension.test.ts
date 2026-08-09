import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = fileURLToPath(new URL("../../../", import.meta.url));

describe("Pi collector runtime", () => {
	test("the Node-targeted bundle loads and invokes under node", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-pi-node-"));
		const output = join(root, "collectors", "pi");
		const extension = join(output, "extension.js");

		try {
			await mkdir(output, { recursive: true });
			await execFileAsync(
				process.execPath,
				[
					"build",
					"collectors/pi/src/extension.ts",
					"--target=node",
					"--format=esm",
					"--outfile",
					extension,
				],
				{ cwd: workspace },
			);
			await writeFile(join(output, "package.json"), '{"type":"module","main":"extension.js"}\n');

			const moduleUrl = pathToFileURL(extension).href;
			const invoke = `
				if (process.release.name !== "node") throw new Error("test did not run under node");
				const loaded = await import(${JSON.stringify(moduleUrl)});
				const events = [];
				loaded.default({ on(name) { events.push(name); } });
				console.log("invoked under node: " + events.join(","));
			`;
			const { stdout, stderr } = await execFileAsync("node", ["--input-type=module", "--eval", invoke]);

			expect(stderr).not.toContain("ReferenceError");
			expect(stdout).toContain("invoked under node: session_start");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
