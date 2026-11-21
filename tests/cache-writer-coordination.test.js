const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const writerScript = `
	const assert = require("node:assert/strict");
	const fs = require("node:fs/promises");
	const { once } = require("node:events");
	const [cachePath, key, pauseBeforeRename] = process.argv.slice(1);
	const Cache = require(cachePath);
	const { rename } = fs;

	(async () => {
		const cache = new Cache();
		const seen = [await cache.get("seed"), await cache.get("first"), await cache.get("second")];
		if (pauseBeforeRename === "pause") {
			fs.rename = async (source, destination) => {
				const resume = once(process, "message");
				process.send(seen);
				const [command] = await resume;
				assert.equal(command, "publish");
				await rename(source, destination);
			};
		}
		assert.equal(await cache.set({ key, value: key }), true);
		const reported = new Promise((resolve, reject) => {
			process.send(seen, error => error ? reject(error) : resolve());
		});
		await reported;
		process.disconnect();
	})().catch(error => {
		console.error(error);
		process.exitCode = 1;
		process.disconnect();
	});
`;

function startWriter (directory, key, pauseBeforeRename = false) {
	const args = ["-e", writerScript, require.resolve("../singleton/cache.js"), key];
	if (pauseBeforeRename) {
		args.push("pause");
	}
	const child = spawn(process.execPath, args, {
		cwd: directory,
		stdio: ["ignore", "ignore", "inherit", "ipc"],
		timeout: 5000,
		killSignal: "SIGKILL"
	});
	const exited = once(child, "close");
	const messages = [];
	child.on("message", message => messages.push(message));
	const checkpoint = () => Promise.race([
		once(child, "message").then(([message]) => message),
		exited.then(status => assert.fail(`Writer exited before checkpoint: ${status}`))
	]);
	return { child, exited, messages, checkpoint };
}

test("Independent cache writers can overwrite a committed snapshot with a stale one", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-cache-writers-"));
	let first;
	try {
		assert.deepEqual(await startWriter(directory, "seed").exited, [0, null]);
		first = startWriter(directory, "first", true);
		assert.deepEqual(await first.checkpoint(), ["seed", null, null]);

		const second = startWriter(directory, "second");
		assert.deepEqual(await second.exited, [0, null]);
		assert.deepEqual(second.messages, [["seed", null, null]]);
		const primary = join(directory, "data/cache.json");
		assert.match(readFileSync(primary, "utf8"), /keyv:second/u);

		first.child.send("publish");
		assert.deepEqual(await first.exited, [0, null]);
		const snapshot = readFileSync(primary, "utf8");
		assert.match(snapshot, /keyv:first/u);
		assert.match(snapshot, /keyv:seed/u);
		assert.doesNotMatch(snapshot, /keyv:second/u);
	}
	finally {
		first?.child.kill("SIGKILL");
		await first?.exited.catch(() => {});
		rmSync(directory, { recursive: true, force: true });
	}
});
