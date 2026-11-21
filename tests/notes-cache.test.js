const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync } = require("node:fs");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const Keyv = require("keyv");
const { KeyvFile } = require("keyv-file");
const DataCache = require("../hoyolab-modules/cache.js");
const projectNotesSnapshot = require("../hoyolab-modules/notes-cache-projection.js");
const Cache = require("../singleton/cache.js");

const uid = "synthetic-role";
const account = { uid, region: "os_euro", stamina: { threshold: 100 } };
const notesKey = "notes:[\"genshin\",\"os_euro\",\"synthetic-role\"]";
const now = 1800000000000;
const ttl = 3600000;

test("Notes projection leaves the source snapshot and its nested fields untouched", () => {
	const snapshot = {
		uid,
		lastUpdate: now - 1000,
		expires: now - 60000,
		stamina: { currentStamina: "40", maxStamina: 200, recoveryTime: "600" },
		expedition: {
			completed: false,
			list: [{ status: "Ongoing", remaining_time: "30" }, { status: "Ongoing", remaining_time: "60" }]
		},
		realm: { currentCoin: 100, maxCoin: 2400, recoveryTime: "3600" }
	};
	const original = structuredClone(snapshot);
	assert.deepEqual(projectNotesSnapshot(snapshot, { now, rate: 10, staminaThreshold: 100 }), {
		...snapshot,
		lastUpdate: now,
		stamina: { ...snapshot.stamina, currentStamina: 40.2, recoveryTime: 598 },
		expedition: {
			...snapshot.expedition,
			list: [{ status: "Ongoing", remaining_time: 28 }, { status: "Ongoing", remaining_time: 58 }]
		},
		realm: { ...snapshot.realm, recoveryTime: 3598 }
	});
	assert.deepEqual(snapshot, original);
});

const setup = (t, data) => {
	t.mock.method(Date, "now", () => now);
	const previousApp = globalThis.app;
	t.after(() => {
		globalThis.app = previousApp;
	});
	const writes = [];
	const deletes = [];
	globalThis.app = {
		Logger: { debug: () => {} },
		Cache: {
			get: async (key) => key === notesKey ? structuredClone(data) : undefined,
			set: async (entry) => writes.push(structuredClone(entry)),
			delete: async (key) => deletes.push(key)
		}
	};
	return { cache: new DataCache("genshin", 10), writes, deletes };
};

test("Notes cache projects legacy lastUpdated and keeps the original TTL window", async (t) => {
	const data = {
		uid,
		lastUpdated: now - 9000,
		expires: now - 60000,
		stamina: { currentStamina: "40", maxStamina: 200, recoveryTime: "600" },
		expedition: { completed: false, list: [{ status: "Ongoing", remaining_time: "30" }]},
		realm: { currentCoin: 100, maxCoin: 2400, recoveryTime: "3600" }
	};
	const { cache, writes, deletes } = setup(t, data);
	const expected = {
		...data,
		lastUpdate: now,
		stamina: { currentStamina: 41, maxStamina: 200, recoveryTime: 590 },
		expedition: { completed: false, list: [{ status: "Ongoing", remaining_time: 20 }]},
		realm: { currentCoin: 100, maxCoin: 2400, recoveryTime: 3590 }
	};
	assert.deepEqual(await cache.get(account), expected);
	assert.deepEqual(writes, [{ key: notesKey, value: expected, expiry: ttl - 60000 }]);
	assert.deepEqual(deletes, []);
});

test("Notes cache initializes a missing timestamp and retains stamina at the threshold", async (t) => {
	const data = { uid, expires: now, stamina: { currentStamina: 100, maxStamina: 200, recoveryTime: 50 } };
	const { cache, writes, deletes } = setup(t, data);
	const expected = { ...data, lastUpdate: now };
	assert.deepEqual(await cache.get(account), expected);
	assert.deepEqual(writes, [{ key: notesKey, value: expected, expiry: ttl }]);
	assert.deepEqual(deletes, []);
});

for (const [reason, fields] of [
	["stamina rises above the threshold", { stamina: { currentStamina: 100, maxStamina: 200, recoveryTime: 50 } }],
	["stamina reaches its cap below the threshold", { stamina: { currentStamina: 89.8, maxStamina: 90, recoveryTime: 2 } }],
	["expedition reaches zero", { expedition: { list: [{ remaining_time: "2" }]} }],
	["shop is finished", { shop: { state: "Finished" } }],
	["realm is full", { realm: { currentCoin: 2400, maxCoin: 2400, recoveryTime: 10 } }],
	["realm timer reaches zero", { realm: { currentCoin: 100, maxCoin: 2400, recoveryTime: "2" } }]
]) {
	test(`Notes cache invalidates when ${reason}`, async (t) => {
		const { cache, writes, deletes } = setup(t, { uid, lastUpdate: now - 1000, expires: now, ...fields });
		assert.equal(await cache.get(account), null);
		assert.deepEqual(writes, []);
		assert.deepEqual(deletes, [notesKey]);
	});
}

const pauseOperation = () => {
	let signal;
	let resume;
	const reached = new Promise(resolve => {
		signal = resolve;
	});
	const pending = new Promise(resolve => {
		resume = resolve;
	});
	return {
		reached,
		resume,
		pause: () => {
			signal();
			return pending;
		}
	};
};

const staleSnapshot = {
	uid,
	lastUpdate: now - 1000,
	expires: now - 60000,
	expedition: { list: [{ remaining_time: "30" }]}
};
const freshSnapshot = {
	uid,
	lastUpdate: now,
	expires: now,
	expedition: { list: [{ remaining_time: "300" }]}
};

test("Notes ignores unscoped UID snapshots when reopening the file cache", async t => {
	const { cache } = setup(t);
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-notes-"));
	const previousDirectory = process.cwd();
	process.chdir(directory);
	try {
		app.Cache = new Cache();
		await app.Cache.set({ key: uid, value: staleSnapshot, expiry: ttl });
		app.Cache = new Cache();

		assert.equal(await cache.get(account), null);
		await cache.set(account, freshSnapshot);
		const reopened = new Cache();
		assert.deepEqual(await reopened.get(uid), staleSnapshot);
		assert.deepEqual(await reopened.get(notesKey), freshSnapshot);
	}
	finally {
		process.chdir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Notes rechecks the request cookie after waiting for the cache queue", async t => {
	const { cache, writes } = setup(t);
	const role = { ...account, cookie: "synthetic-original" };
	const readGate = pauseOperation();
	const responseGate = pauseOperation();
	t.mock.method(app.Cache, "get", async () => {
		await readGate.pause();
		return undefined;
	});
	const read = cache.get(role);
	await readGate.reached;
	const fetch = cache.fetch(role, async saveSnapshot => {
		const save = saveSnapshot(staleSnapshot);
		await responseGate.pause();
		await save;
		return staleSnapshot;
	});
	await responseGate.reached;
	role.cookie = "synthetic-rotated";
	readGate.resume();
	responseGate.resume();
	await read;
	assert.equal(await fetch, staleSnapshot);
	assert.deepEqual(writes, []);
});

test("An older Notes fetch can save while a newer fetch is pending", async t => {
	const { cache, writes } = setup(t);
	const older = pauseOperation();
	const newer = pauseOperation();
	const fetch = (gate, snapshot) => cache.fetch(account, async saveSnapshot => {
		await gate.pause();
		await saveSnapshot(snapshot);
	});
	const olderFetch = fetch(older, staleSnapshot);
	const newerFetch = fetch(newer, freshSnapshot);

	older.resume();
	await olderFetch;
	assert.deepEqual(writes.map(entry => entry.value), [staleSnapshot]);

	newer.resume();
	await newerFetch;
	assert.deepEqual(writes.map(entry => entry.value), [staleSnapshot, freshSnapshot]);
});

for (const rejects of [true, false]) {
	const failure = rejects ? "rejects" : "returns false";
	test(`An older Notes fetch can save when the newer write ${failure}`, async t => {
		const { cache, writes } = setup(t);
		const error = new Error("Synthetic cache write failure");
		const { set } = app.Cache;
		t.mock.method(app.Cache, "set", async entry => {
			if (entry.value === freshSnapshot) {
				if (rejects) {
					throw error;
				}
				return false;
			}
			return await set(entry);
		});

		const older = pauseOperation();
		const olderFetch = cache.fetch(account, async saveSnapshot => {
			await older.pause();
			await saveSnapshot(staleSnapshot);
		});
		const newerFetch = new DataCache("genshin", 10).fetch(account, saveSnapshot => saveSnapshot(freshSnapshot));
		if (rejects) {
			await assert.rejects(newerFetch, error);
		}
		else {
			await newerFetch;
		}

		older.resume();
		await olderFetch;
		assert.deepEqual(writes, [{ key: notesKey, value: staleSnapshot, expiry: ttl }]);
	});
}

for (const remaining of [1, 0, -1]) {
	test(`Notes with ${remaining} ms of TTL remaining uses the real file cache`, async t => {
		const { cache } = setup(t);
		const directory = mkdtempSync(join(tmpdir(), "hoyoutils-notes-"));
		const previousDirectory = process.cwd();
		process.chdir(directory);
		try {
			app.Cache = new Cache();
			const snapshot = { ...staleSnapshot, expires: now - ttl + remaining };
			// Simulate an existing Notes entry whose backend TTL exceeds its snapshot deadline.
			await app.Cache.set({ key: notesKey, value: snapshot, expiry: ttl });
			const expected = remaining > 0
				? { ...snapshot, lastUpdate: now, expedition: { list: [{ remaining_time: 28 }]} }
				: null;
			const projected = await cache.get(account);

			const persisted = JSON.parse(readFileSync(join(directory, "data/cache.json"), "utf8")).cache;
			const reopenedCache = new Cache();
			assert.equal(persisted.length, remaining > 0 ? 1 : 0);
			if (remaining > 0) {
				assert.equal(persisted[0][1].expire, now + remaining);
			}
			assert.deepEqual(await app.Cache.get(notesKey), expected ?? undefined);
			assert.deepEqual(await reopenedCache.get(notesKey), expected ?? undefined);
			assert.deepEqual(projected, expected);
		}
		finally {
			process.chdir(previousDirectory);
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

for (const expired of [false, true]) {
	const reason = expired ? "TTL expiration" : "explicit invalidation";
	test(`Notes persists ${reason} during a save for another key`, async t => {
		const { cache } = setup(t);
		const directory = mkdtempSync(join(tmpdir(), "hoyoutils-notes-"));
		const previousDirectory = process.cwd();
		const saving = pauseOperation();
		const otherKey = "other-cache-entry";
		const otherValue = { updated: true };
		let write;
		let invalidation;

		process.chdir(directory);
		try {
			app.Cache = new Cache();
			const snapshot = expired ? { ...staleSnapshot, expires: now - ttl } : staleSnapshot;
			await app.Cache.set({ key: notesKey, value: snapshot, expiry: ttl });

			const { rename } = fs;
			t.mock.method(fs, "rename", async (...args) => {
				await saving.pause();
				await rename(...args);
			}, { times: 1 });

			write = app.Cache.set({ key: otherKey, value: otherValue });
			await saving.reached;
			assert.deepEqual(await app.Cache.get(notesKey), snapshot);

			invalidation = expired ? cache.get(account) : cache.invalidateCache(account);
			await nextTurn();
			assert.equal(await app.Cache.get(notesKey), undefined);
			saving.resume();
			await write;
			assert.equal(await invalidation, expired ? null : undefined);

			const reopened = new Cache();
			assert.deepEqual(await reopened.get(otherKey), otherValue);
			assert.equal(await reopened.get(notesKey), undefined);
		}
		finally {
			saving.resume();
			await Promise.allSettled([write, invalidation]);
			process.chdir(previousDirectory);
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("The file cache recovers after a write fails during Notes invalidation", async t => {
	const { cache } = setup(t);
	const directory = mkdtempSync(join(tmpdir(), "hoyoutils-notes-"));
	const previousDirectory = process.cwd();
	const filename = join(directory, "data/cache.json");
	const backup = join(directory, "cache-backup.json");
	const errors = [];
	app.Logger.error = (_category, message) => errors.push(message);

	process.chdir(directory);
	try {
		app.Cache = new Cache();
		await app.Cache.set({ key: notesKey, value: staleSnapshot, expiry: ttl });

		renameSync(filename, backup);
		mkdirSync(filename);
		await cache.invalidateCache(account);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /EISDIR|ENOTDIR|EPERM|EACCES/);
		assert.deepEqual(readdirSync(join(directory, "data")), ["cache.json"]);
		assert.equal(await app.Cache.get(notesKey), undefined);

		rmdirSync(filename);
		renameSync(backup, filename);
		assert.deepEqual(await new Cache().get(notesKey), staleSnapshot);

		const otherKey = "other-cache-entry";
		const otherValue = { updated: true };
		await assert.doesNotReject(
			app.Cache.set({ key: otherKey, value: otherValue }),
			"The next write should succeed after the filesystem recovers"
		);
		const reopened = new Cache();
		assert.deepEqual(await reopened.get(otherKey), otherValue);
		assert.equal(await reopened.get(notesKey), undefined);
	}
	finally {
		process.chdir(previousDirectory);
		rmSync(directory, { recursive: true, force: true });
	}
});

const batchScenarios = [
	{ scenario: "early projections", expectedRenames: 1 },
	{ scenario: "late projection", expectedRenames: 2 },
	{ scenario: "early invalidation", expectedRenames: 1 },
	{ scenario: "late invalidation", expectedRenames: 2 },
	{ scenario: "write failure", expectedRenames: 2 }
];
for (const { scenario, expectedRenames } of batchScenarios) {
	test(`Notes persistence: ${scenario}`, { timeout: 5000 }, async t => {
		const { cache } = setup(t);
		const directory = mkdtempSync(join(tmpdir(), "hoyoutils-notes-batch-"));
		const previousDirectory = process.cwd();
		const filename = "./data/cache.json";
		const otherRole = { ...account, uid: "second-role" };
		const otherKey = "notes:[\"genshin\",\"os_euro\",\"second-role\"]";
		const writerKey = "scheduler:synthetic";
		const writerValue = { lastAttemptDate: "2026-11-21" };
		const otherSnapshot = { ...staleSnapshot, uid: otherRole.uid };
		const original = [staleSnapshot, otherSnapshot, undefined];
		const projected = original.slice(0, 2).map(snapshot => ({
			...snapshot, lastUpdate: now, expedition: { list: [{ remaining_time: 28 }]}
		}));
		const expiry = staleSnapshot.expires + ttl;
		const keys = [notesKey, otherKey, writerKey];
		const captured = pauseOperation();
		const pending = [];
		const invalidates = scenario.endsWith("invalidation");
		const late = !scenario.startsWith("early");
		const fails = scenario === "write failure";
		const failure = Object.assign(new Error("Synthetic rename failure"), { code: "EIO" });
		let attempts = 0;
		let renames = 0;

		const inspect = async () => {
			const entries = new Map(JSON.parse(readFileSync(filename, "utf8")).cache);
			const reopened = new Cache();
			const values = await Promise.all(keys.map(key => reopened.get(key)));
			for (const [index, key] of keys.entries()) {
				const entry = entries.get(`keyv:${key}`);
				if (values[index] === undefined) {
					assert.equal(entry, undefined);
				}
				else {
					const deadline = index === 2 ? null : expiry;
					assert.deepEqual(JSON.parse(entry.value), { value: values[index], expires: deadline });
					assert.equal(entry.expire, deadline ?? undefined);
				}
			}
			return values;
		};

		const observe = (operation) => {
			const observed = (async () => {
				const [result] = await Promise.allSettled([operation]);
				return { result, disk: await inspect() };
			})();
			pending.push(observed);
			return observed;
		};

		process.chdir(directory);
		try {
			app.Cache = new Cache();
			await Promise.all(keys.slice(0, 2).map((key, index) => app.Cache.set({
				key, value: original[index], expiry: expiry - now
			})));
			assert.deepEqual(await inspect(), original);
			const { rename } = fs;
			t.mock.method(fs, "rename", async (source, target) => {
				assert.equal(target, filename);
				if (++attempts === 1 && late) {
					await captured.pause();
					if (fails) {
						throw failure;
					}
				}
				await rename(source, target);
				renames++;
			});

			// Use set on failure so the rejection reaches the caller instead of a Notes miss.
			const first = observe(fails ? app.Cache.set({ key: notesKey, value: projected[0], expiry: expiry - now }) : cache.get(account));
			if (late) {
				await captured.reached;
				assert.deepEqual(await inspect(), original);
			}
			const second = observe(invalidates
				? cache.invalidateCache(otherRole)
				: (fails
					? app.Cache.set({ key: otherKey, value: projected[1], expiry: expiry - now })
					: cache.get(otherRole)));
			const writer = invalidates && observe(app.Cache.set({ key: writerKey, value: writerValue, durable: true }));
			if (late) {
				await nextTurn();
				assert.deepEqual(await app.Cache.get(otherKey), invalidates ? undefined : projected[1]);
				if (writer) {
					assert.deepEqual(await app.Cache.get(writerKey), writerValue);
				}
				captured.resume();
			}
			const [a, b] = await Promise.all([first, second]);
			if (fails) {
				const recovered = [...projected, undefined];
				assert.deepEqual(a, { result: { status: "rejected", reason: failure }, disk: original });
				assert.deepEqual(b, { result: { status: "fulfilled", value: true }, disk: recovered });
				assert.equal(await app.Cache.set({ key: writerKey, value: writerValue }), true);
				assert.deepEqual(await inspect(), [...projected, writerValue]);
				assert.deepEqual(readdirSync("data"), ["cache.json"]);
			}
			else {
				assert.deepEqual(a.result, { status: "fulfilled", value: projected[0] });
				const final = [projected[0], invalidates ? undefined : projected[1], writer ? writerValue : undefined];
				const firstDisk = late ? [projected[0], otherSnapshot, undefined] : final;
				assert.deepEqual(a.disk, firstDisk);
				assert.deepEqual(b.result, { status: "fulfilled", value: final[1] });
				assert.deepEqual(b.disk, final);
				if (writer) {
					assert.deepEqual(await writer, { result: { status: "fulfilled", value: true }, disk: final });
				}
			}
			assert.equal(renames, expectedRenames);
			assert.equal(attempts, renames + Number(fails));
			t.diagnostic(`${renames} successful renames from ${attempts} attempts, ${fails ? "including recovery" : "excluding seed"}`);
		}
		finally {
			captured.resume();
			await Promise.allSettled(pending);
			process.chdir(previousDirectory);
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

const setupKeyv = async (t, onDisk, snapshot) => {
	const { cache } = setup(t);
	const directory = onDisk ? mkdtempSync(join(tmpdir(), "hoyoutils-notes-")) : undefined;
	const filename = directory && join(directory, "cache.json");
	const file = filename && new KeyvFile({ filename, writeDelay: 0 });
	const store = new Keyv({ store: file });
	let pendingSave;
	if (file) {
		const save = file.save.bind(file);
		t.mock.method(file, "save", () => {
			pendingSave = save();
			return pendingSave;
		});
		t.after(() => rmSync(directory, { recursive: true, force: true }));
	}
	app.Cache = {
		get: key => store.get(String(key)),
		set: ({ key, value, expiry }) => store.set(String(key), value, expiry || undefined),
		delete: key => store.delete(String(key))
	};
	await store.set(notesKey, snapshot, ttl - 60000);
	return {
		cache,
		file,
		readStored: async () => {
			await pendingSave;
			const persisted = file ? new Keyv({ store: new KeyvFile({ filename }) }) : store;
			return {
				current: await store.get(notesKey, { raw: true }),
				persisted: await persisted.get(notesKey, { raw: true })
			};
		}
	};
};

test("Concurrent Notes reads project in order and preserve the original TTL window", async t => {
	const { cache, readStored } = await setupKeyv(t, true, staleSnapshot);
	const first = { ...staleSnapshot, lastUpdate: now, expedition: { list: [{ remaining_time: 28 }]} };
	const second = { ...first, expedition: { list: [{ remaining_time: 27 }]} };
	assert.deepEqual(await Promise.all([cache.get(account), cache.get(account)]), [first, second]);
	const expected = { value: second, expires: staleSnapshot.expires + ttl };
	assert.deepEqual(await readStored(), { current: expected, persisted: expected });
});

test("A failed Notes cache write does not stall the next write to the same key", async t => {
	const { cache, readStored } = await setupKeyv(t, false, staleSnapshot);
	t.mock.method(app.Cache, "set", async () => {
		throw new Error("synthetic write failure");
	}, { times: 1 });
	const failed = cache.set(account, staleSnapshot);
	const next = cache.set(account, freshSnapshot);
	await assert.rejects(failed, /synthetic write failure/);
	await next;
	const expected = { value: freshSnapshot, expires: now + ttl };
	assert.deepEqual(await readStored(), { current: expected, persisted: expected });
});

for (const onDisk of [false, true]) {
	const backend = onDisk ? "KeyvFile" : "Keyv";
	for (const action of ["invalidate", "replace", "replace expired projection"]) {
		test(`${backend}: ${action} after a Notes read captures the previous snapshot`, async t => {
			const snapshot = action === "replace expired projection"
				? { ...staleSnapshot, expedition: { list: [{ remaining_time: "2" }]} }
				: staleSnapshot;
			const { cache, readStored } = await setupKeyv(t, onDisk, snapshot);
			const read = app.Cache.get;
			const captured = pauseOperation();
			t.mock.method(app.Cache, "get", async key => {
				const value = await read(key);
				await captured.pause();
				return value;
			});

			const projection = cache.get(account);
			await captured.reached;
			const mutation = action === "invalidate" ? cache.invalidateCache(account) : new DataCache("genshin", 10).set(account, freshSnapshot);
			await nextTurn();
			captured.resume();
			await Promise.all([projection, mutation]);

			const expected = action === "invalidate" ? undefined : { value: freshSnapshot, expires: now + ttl };
			assert.deepEqual(await readStored(), { current: expected, persisted: expected });
		});
	}
}

for (const action of ["invalidate", "replace"]) {
	test(`KeyvFile: ${action} while a Notes rewrite is saving to disk`, async t => {
		const { cache, file, readStored } = await setupKeyv(t, true, staleSnapshot);
		const saving = pauseOperation();
		const saveToDisk = file.saveToDisk.bind(file);
		t.mock.method(file, "saveToDisk", async () => {
			await saveToDisk();
			await saving.pause();
		}, { times: 1 });

		const projection = cache.get(account);
		await saving.reached;
		const mutation = action === "invalidate" ? cache.invalidateCache(account) : cache.set(account, freshSnapshot);
		await nextTurn();
		saving.resume();
		await Promise.all([projection, mutation]);

		const expected = action === "invalidate" ? undefined : { value: freshSnapshot, expires: now + ttl };
		assert.deepEqual(await readStored(), { current: expected, persisted: expected });
	});
}
