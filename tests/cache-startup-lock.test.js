const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { test } = require("node:test");

const probe = require.resolve("./helpers/cache-startup-probe.js");
const entryPoint = require.resolve("../index.js");

function runProbe (cwd, { hold = false, refuse = false, env } = {}) {
	const child = spawn(process.execPath, ["--require", probe, entryPoint], {
		cwd,
		env: {
			...process.env,
			CONFIG_PATH: "./config.json5",
			CACHE_PROBE_HOLD: hold ? "1" : "0",
			CACHE_PROBE_EXPECT_REFUSAL: refuse ? "1" : "0",
			...env
		},
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 10000,
		killSignal: "SIGKILL"
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", data => {
		stdout += data;
	});
	child.stderr.on("data", data => {
		stderr += data;
	});
	const exited = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
	const ready = async () => {
		const lines = createInterface({ input: child.stdout });
		try {
			return await Promise.race([
				once(lines, "line").then(([line]) => JSON.parse(line)),
				exited.then(({ stderr }) => assert.fail(`Probe exited before writing the cache: ${stderr}`))
			]);
		}
		finally {
			lines.close();
		}
	};
	return { child, exited, ready };
}

function makeWorkspace (t, platforms = [{}]) {
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-startup-lock-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "config.json5"), JSON.stringify({ platforms }));
	return directory;
}

test("Startup holds the same lock inode across working-directory aliases and releases it on exit", { skip: process.platform !== "linux" }, async t => {
	const directory = makeWorkspace(t);
	const alias = join(directory, "alias");
	symlinkSync(directory, alias, "dir");
	const lock = join(directory, "data/cache-writer.lock");
	const primary = join(directory, "data/cache.json");

	for (const [index, signal] of [null, "SIGKILL"].entries()) {
		const first = runProbe(directory, { hold: true });
		try {
			const ready = await first.ready();
			const { dev, ino } = statSync(lock);
			assert.equal(ready.seed, index === 0 ? null : 2);
			assert.deepEqual([ready.device, ready.inode], [dev, ino]);
			const previous = readFileSync(primary);
			const refused = await runProbe(alias, { refuse: true }).exited;
			assert.deepEqual([refused.code, refused.stdout], [1, ""]);
			assert.match(refused.stderr, /Cache writer lock unavailable.*flock exited with 1/u);
			assert.doesNotMatch(refused.stderr, /Got initialized/u);
			assert.deepEqual(readFileSync(primary), previous);

			if (signal) {
				first.child.kill(signal);
			}
			else {
				first.child.stdin.end();
			}
			const exited = await first.exited;
			assert.deepEqual([exited.code, exited.signal], [signal ? null : 0, signal]);

			const successor = await runProbe(alias).exited;
			assert.equal(successor.code, 0, successor.stderr);
			assert.deepEqual(JSON.parse(successor.stdout), { ...ready, seed: index * 2 + 1 });
			assert.equal(statSync(lock).ino, ready.inode);
		}
		finally {
			first.child.kill("SIGKILL");
			await first.exited;
		}
	}
});

test("Startup fails before touching the primary when flock is missing or the lock path is a link", { skip: process.platform !== "linux" }, async t => {
	const directory = makeWorkspace(t);
	mkdirSync(join(directory, "data"));
	const primary = join(directory, "data/cache.json");
	const lock = join(directory, "data/cache-writer.lock");
	const snapshot = "{\"cache\":[],\"lastExpire\":0}";
	writeFileSync(primary, snapshot);

	const missing = await runProbe(directory, { refuse: true, env: { PATH: directory } }).exited;
	assert.deepEqual([missing.code, missing.stdout], [1, ""]);
	assert.match(missing.stderr, /Cache writer lock unavailable.*spawnSync flock ENOENT/u);
	assert.doesNotMatch(missing.stderr, /Got initialized/u);
	assert.equal(readFileSync(primary, "utf8"), snapshot);

	rmSync(lock);
	symlinkSync(primary, lock);
	const linked = await runProbe(directory, { refuse: true }).exited;
	assert.deepEqual([linked.code, linked.stdout], [1, ""]);
	assert.match(linked.stderr, /Cache writer lock unavailable.*ELOOP/u);
	assert.doesNotMatch(linked.stderr, /Got initialized/u);
	assert.equal(readFileSync(primary, "utf8"), snapshot);
});

test("Replacing a live lock inode defeats cooperative writer exclusion", { skip: process.platform !== "linux" }, async t => {
	const directory = makeWorkspace(t);
	const lock = join(directory, "data/cache-writer.lock");
	const first = runProbe(directory, { hold: true });
	try {
		const ready = await first.ready();
		renameSync(lock, `${lock}.old`);
		const successor = await runProbe(directory).exited;
		assert.equal(successor.code, 0, successor.stderr);
		const acquired = JSON.parse(successor.stdout);
		assert.notEqual(acquired.inode, ready.inode);
		assert.equal(acquired.seed, 1);
	}
	finally {
		first.child.kill("SIGKILL");
		await first.exited;
	}
});

test("Startup without platforms exits without creating the data directory", async t => {
	const directory = makeWorkspace(t, []);
	const result = await runProbe(directory, { refuse: true, env: { PATH: directory } }).exited;
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stderr, /No platforms configured/u);
	assert.equal(existsSync(join(directory, "data")), false);
});

test("Startup outside Linux uses the cache without flock", { skip: process.platform === "linux" }, async t => {
	const directory = makeWorkspace(t);
	const result = await runProbe(directory, { env: { PATH: directory } }).exited;
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { seed: null });
	assert.equal(existsSync(join(directory, "data/cache-writer.lock")), false);
});
