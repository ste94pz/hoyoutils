const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const Cache = require("../singleton/cache.js");

test("The file cache persists successive batches on the same key in order", { timeout: 5000 }, async t => {
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-cache-"));
	const previousDirectory = process.cwd();
	let resume;
	let captured;
	const paused = new Promise(resolve => {
		resume = resolve;
	});
	const capturing = new Promise(resolve => {
		captured = resolve;
	});
	const { rename } = fs;
	const reopens = [];
	const observe = async operation => {
		const result = await operation;
		return [result, await new Cache().get("attempt")];
	};
	process.chdir(directory);
	try {
		const cache = new Cache();
		await cache.set({ key: "attempt", value: "original", durable: true });
		const writer = t.mock.method(fs, "rename", async (...args) => {
			if (writer.mock.callCount() === 0) {
				captured();
				await paused;
			}
			await rename(...args);
		});
		reopens.push(observe(cache.set({ key: "attempt", value: "first", durable: true })));
		await capturing;
		assert.equal(await new Cache().get("attempt"), "original");

		reopens.push(observe(cache.set({ key: "attempt", value: "overwritten", durable: true })));
		await nextTurn();
		assert.equal(await cache.get("attempt"), "overwritten");
		reopens.push(observe(cache.set({ key: "attempt", value: "latest", durable: true })));
		await nextTurn();
		assert.equal(await cache.get("attempt"), "latest");
		resume();
		assert.deepEqual(await Promise.all(reopens), [[true, "first"], [true, "latest"], [true, "latest"]]);
		assert.equal(writer.mock.callCount(), 2);
	}
	finally {
		resume();
		await Promise.allSettled(reopens);
		process.chdir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("A failed save rejects its entire batch and a later save can persist its mutations", async t => {
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-cache-"));
	const previousDirectory = process.cwd();
	const failure = Object.assign(new Error("Synthetic rename failure"), { code: "EIO" });
	process.chdir(directory);
	try {
		const cache = new Cache();
		await cache.set({ key: "obsolete", value: "original" });
		t.mock.method(fs, "rename", async () => {
			throw failure;
		}, { times: 1 });
		const results = await Promise.allSettled([
			cache.delete("obsolete", { durable: true }),
			cache.set({ key: "attempt", value: "new", durable: true })
		]);
		const rejected = { status: "rejected", reason: failure };
		assert.deepEqual(results, [rejected, rejected]);
		assert.equal(await new Cache().get("obsolete"), "original");
		assert.equal(await new Cache().get("attempt"), undefined);

		assert.equal(await cache.set({ key: "other", value: "recovery" }), true);
		const reopened = new Cache();
		assert.equal(await reopened.get("obsolete"), undefined);
		assert.equal(await reopened.get("attempt"), "new");
		assert.equal(await reopened.get("other"), "recovery");
	}
	finally {
		process.chdir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("The file cache preserves the last complete snapshot when a writer is killed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-cache-"));
	const previousDirectory = process.cwd();
	const filename = join(directory, "data/cache.json");
	process.chdir(directory);
	try {
		const cache = new Cache();
		await cache.set({ key: "attempt", value: "previous", durable: true });
		const previous = readFileSync(filename, "utf8");
		const write = `
			const fs = require("node:fs");
			const { createRequire } = require("node:module");
			const requireCache = createRequire(process.argv[1]);
			const requireKeyvFile = createRequire(requireCache.resolve("keyv-file"));
			const stopAfterPartialWrite = () => {
				process.on("disconnect", () => {});
				process.send("partial write");
			};

			// Interruption point in KeyvFile's original in-place writer.
			requireKeyvFile("fs-extra").outputFile = (path, data) => {
				fs.writeFileSync(path, data.slice(0, 1));
				stopAfterPartialWrite();
			};

			// Interruption point in the replacement writer, after opening the actual output file.
			const { open } = fs.promises;
			fs.promises.open = async (...args) => {
				const file = await open(...args);
				const writeFile = file.writeFile.bind(file);
				file.writeFile = async data => {
					await writeFile(data.slice(0, 1));
					stopAfterPartialWrite();
					await new Promise(() => {});
				};
				return file;
			};
			const Cache = requireCache(process.argv[1]);
			new Cache().set({ key: "attempt", value: "interrupted" });
		`;
		const child = spawn(process.execPath, ["-e", write, require.resolve("../singleton/cache.js")], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
			timeout: 10000
		});
		let checkpoint;
		child.once("message", message => {
			checkpoint = message;
			child.kill("SIGKILL");
		});
		const [, signal] = await once(child, "exit");
		assert.equal(checkpoint, "partial write");
		assert.equal(signal, "SIGKILL");
		assert.equal(readFileSync(filename, "utf8"), previous, "The interrupted write replaced the complete snapshot");

		const reopened = new Cache();
		assert.equal(await reopened.get("attempt"), "previous");
		await reopened.set({ key: "attempt", value: "recovered" });
		assert.equal(await new Cache().get("attempt"), "recovered");
	}
	finally {
		process.chdir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Interrupted cache writers leave one temporary snapshot each across restarts", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-cache-"));
	const previousDirectory = process.cwd();
	const data = join(directory, "data");
	const filename = join(data, "cache.json");
	const unrelated = "notes.tmp";
	const lookalike = `cache.json.${randomUUID()}.tmp`;
	const temporaryName = /^cache\.json\.[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.tmp$/u;
	const files = () => readdirSync(data).sort();
	const write = `
		const assert = require("node:assert/strict");
		const fs = require("node:fs/promises");
		const { basename } = require("node:path");
		const Cache = require(process.argv[1]);
		const cache = new Cache();
		(async () => {
			assert.equal(await cache.get("attempt"), "previous");
			fs.rename = async temporary => {
				process.on("disconnect", () => {});
				process.send(basename(temporary));
				await new Promise(() => {});
			};
			await cache.set({ key: "attempt", value: process.argv[2] });
		})().catch(error => {
			console.error(error);
			process.exitCode = 1;
		});
	`;

	process.chdir(directory);
	try {
		await new Cache().set({ key: "attempt", value: "previous" });
		const previous = readFileSync(filename, "utf8");
		writeFileSync(join(data, unrelated), "unrelated");
		const expectedFiles = ["cache.json", unrelated];
		const orphans = new Map();
		for (let attempt = 1; attempt <= 3; attempt++) {
			const child = spawn(process.execPath, ["-e", write, require.resolve("../singleton/cache.js"), `interrupted-${attempt}`], {
				cwd: directory,
				stdio: ["ignore", "ignore", "inherit", "ipc"],
				timeout: 10000
			});
			const exited = once(child, "exit");
			let temporary;
			let snapshot;
			try {
				[temporary] = await Promise.race([once(child, "message"), exited.then(() => [])]);
				assert.equal(typeof temporary, "string", "The writer did not reach rename");
				assert.match(temporary, temporaryName);
				assert.ok(!expectedFiles.includes(temporary));
				expectedFiles.push(temporary);
				assert.deepEqual(files(), expectedFiles.sort());
				snapshot = readFileSync(join(data, temporary), "utf8");
				assert.doesNotThrow(() => JSON.parse(snapshot));
				assert.notEqual(snapshot, previous);
				assert.equal(readFileSync(filename, "utf8"), previous);
			}
			finally {
				child.kill("SIGKILL");
				await exited;
			}
			assert.deepEqual(await exited, [null, "SIGKILL"]);
			assert.deepEqual(files(), expectedFiles);
			assert.equal(readFileSync(filename, "utf8"), previous);
			orphans.set(temporary, snapshot);
			if (attempt === 1) {
				// An unrelated file can have both the expected name and valid snapshot bytes.
				copyFileSync(join(data, temporary), join(data, lookalike));
				expectedFiles.push(lookalike);
			}
		}

		assert.equal(orphans.size, 3);
		const reopened = new Cache();
		assert.equal(await reopened.get("attempt"), "previous");
		await reopened.set({ key: "attempt", value: "recovered" });
		assert.equal(await new Cache().get("attempt"), "recovered");
		assert.deepEqual(files(), expectedFiles.sort());
		for (const [temporary, snapshot] of orphans) {
			assert.equal(readFileSync(join(data, temporary), "utf8"), snapshot);
		}
		assert.equal(readFileSync(join(data, lookalike), "utf8"), orphans.values().next().value);
		assert.equal(readFileSync(join(data, unrelated), "utf8"), "unrelated");
	}
	finally {
		process.chdir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});
