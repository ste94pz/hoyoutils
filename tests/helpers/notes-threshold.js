const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { KeyvFile } = require("keyv-file");
const Cache = require("../../singleton/cache.js");
const DataCache = require("../../hoyolab-modules/cache.js");
const { notesKey } = require("./notes-concurrency.js");

const seedNotesNearThreshold = async (game, replies, cache, noteWithStamina, offset) => {
	const [account] = game.accounts;
	const key = notesKey(account);
	const projectedStamina = account.stamina.threshold + offset;
	replies.push(noteWithStamina(projectedStamina - 1));
	const initial = await game.notes(account);
	assert.equal(initial.success, true);

	const seed = cache.get(key);
	const elapsed = game.dataCache.rate;
	const age = (elapsed - 1) * 1000;
	seed.lastUpdate -= age;
	seed.expires -= age;
	return { account, key, seed, elapsed, initial, projectedStamina };
};

module.exports = function testNotesThreshold (gameName, setup, card, noteWithStamina, assertNotesRequest) {
	for (const [boundary, offset] of [["below", -1], ["at", 0], ["above", 1]]) {
		test(`${gameName} Notes: requests and cache mutations ${boundary} the stamina threshold`, async (t) => {
			const { game, requests, replies, cache, writes } = await setup(t);
			replies.push(card());
			await game.login();
			const deleteEntry = t.mock.method(app.Cache, "delete");
			const { account, key, seed, elapsed, initial, projectedStamina } = await seedNotesNearThreshold(game, replies, cache, noteWithStamina, offset);
			assert.equal(requests.length, 2); // Discovery plus the initial Notes request.
			assert.equal(writes.length, 1);
			const ttl = writes[0].expiry;
			const now = Date.now();
			const assertProjection = () => {
				assert.equal(writes.length, 2);
				assert.equal(deleteEntry.mock.callCount(), 0);
				assert.equal(writes[1].key, key);
				assert.equal(writes[1].expiry, ttl - (now - seed.expires));
				assert.equal(writes[1].value.expires, seed.expires);
				assert.equal(writes[1].value.lastUpdate, now);
				assert.deepEqual(writes[1].value.stamina, {
					...seed.stamina,
					currentStamina: projectedStamina,
					recoveryTime: Number(seed.stamina.recoveryTime) - elapsed
				});
			};

			if (offset >= 0) {
				replies.push(() => {
					if (offset === 0) {
						assertProjection();
					}
					else {
						assert.equal(writes.length, 1);
						assert.deepEqual(deleteEntry.mock.calls.map(call => call.arguments), [[key, { durable: true }]]);
						assert.equal(cache.has(key), false);
					}
					return Promise.resolve(noteWithStamina(40));
				});
			}

			const result = await game.notes(account);
			assert.equal(result.success, true);
			if (offset < 0) {
				assert.equal(requests.length, 2);
				assertProjection();
				assert.deepEqual(result.data, { ...writes[1].value, assets: initial.data.assets });
			}
			else {
				assert.equal(requests.length, 3);
				assertNotesRequest(requests[2]);
				assert.equal(writes.length, offset === 0 ? 3 : 2);
				const { assets, ...snapshot } = result.data;
				assert.deepEqual(assets, initial.data.assets);
				assert.equal(snapshot.stamina.currentStamina, 40);
				assert.deepEqual(writes.at(-1), {
					key,
					value: { uid: account.uid, nickname: account.nickname, lastUpdate: now, expires: now, ...snapshot },
					expiry: ttl
				});
			}
		});
	}

	for (const concurrent of [false, true]) {
		const scenario = concurrent ? "with a concurrent success" : "without a concurrent fetch";
		test(`${gameName} Notes: a failed refresh at the stamina threshold ${scenario}`, { timeout: 5000 }, async (t) => {
			const { game, requests, replies, cache, writes } = await setup(t);
			replies.push(card());
			await game.login();
			const { account, key, seed, initial, projectedStamina } = await seedNotesNearThreshold(game, replies, cache, noteWithStamina, 0);
			const deleteEntry = t.mock.method(app.Cache, "delete");
			const ttl = writes[0].expiry;
			const now = Date.now();
			const assertProjectionRetained = () => {
				assert.equal(writes.length, 2);
				assert.equal(deleteEntry.mock.callCount(), 0);
				assert.equal(writes[1].key, key);
				assert.equal(now + writes[1].expiry, seed.expires + ttl);
				assert.equal(writes[1].value.expires, seed.expires);
				assert.equal(writes[1].value.lastUpdate, now);
				assert.equal(writes[1].value.stamina.currentStamina, projectedStamina);
				assert.deepEqual(cache.get(key), writes[1].value);
			};
			const freshStamina = 40;
			const fetchFresh = async () => {
				replies.push(() => {
					// At the same clock tick, one projected second rounds back to the threshold.
					assert.equal(writes.length, 3);
					assert.equal(writes[2].expiry, writes[1].expiry);
					assert.equal(writes[2].value.expires, seed.expires);
					assert.equal(writes[2].value.stamina.currentStamina, projectedStamina);
					assert.deepEqual(cache.get(key), writes[2].value);
					return Promise.resolve(noteWithStamina(freshStamina));
				});
				const fresh = await game.notes(account);
				assert.equal(fresh.success, true);
				assert.equal(fresh.data.stamina.currentStamina, freshStamina);
				assert.equal(writes.length, 4);
			};

			replies.push(async () => {
				assertProjectionRetained();
				if (concurrent) {
					// Complete a second controller call while the first HTTP reply is pending.
					await fetchFresh();
				}
				return { statusCode: 503 };
			});

			assert.deepEqual(await game.notes(account), { success: false });
			assert.equal(requests.length, concurrent ? 4 : 3);
			assertNotesRequest(requests[2]);

			if (concurrent) {
				assert.equal(writes.length, 4);
				assert.deepEqual(cache.get(key), writes[3].value);
				const hit = await game.notes(account);
				assert.equal(hit.success, true);
				assert.equal(hit.data.stamina.currentStamina, freshStamina);
				assert.deepEqual(hit.data, { ...writes[4].value, assets: initial.data.assets });
				assert.equal(writes[4].expiry, ttl);
			}
			else {
				assertProjectionRetained();
				await fetchFresh();
			}

			assert.equal(requests.length, 4);
			assertNotesRequest(requests[3]);
			assert.equal(deleteEntry.mock.callCount(), 0);
			assert.equal(writes[3].value.stamina.currentStamina, freshStamina);
			assert.equal(writes[3].value.expires, now);
			assert.equal(writes[3].expiry, ttl);
		});
	}

	for (const atThreshold of [false, true]) {
		const boundary = atThreshold ? "at" : "below";
		test(`${gameName} Notes: persistent cache cost ${boundary} the stamina threshold`, { timeout: 5000 }, async t => {
			const { game, requests, replies } = await setup(t);
			replies.push(card());
			await game.login();
			const [account] = game.accounts;
			const key = notesKey(account);
			const projectedStamina = account.stamina.threshold - (atThreshold ? 0 : 1);
			const seededAt = Date.now();
			let now = seededAt;
			t.mock.method(Date, "now", () => now);
			const rate = game.dataCache.rate;
			const attempts = 5;
			const filename = "./data/cache.json";
			const previousDirectory = process.cwd();
			const directory = mkdtempSync(join(tmpdir(), "hoyoutils-notes-threshold-"));
			process.chdir(directory);
			try {
				app.Cache = new Cache();
				replies.push(noteWithStamina(projectedStamina - 1));
				const initial = await game.notes(account);
				assert.equal(initial.success, true);
				const { assets, ...initialSnapshot } = initial.data;

				const lookups = t.mock.method(KeyvFile.prototype, "get");
				const committedBytes = [];
				const { rename } = fs;
				t.mock.method(fs, "rename", async (source, target) => {
					await rename(source, target);
					if (target === filename) {
						committedBytes.push((await fs.stat(target)).size);
					}
				});

				for (let attempt = 0; attempt < attempts; attempt++) {
					// Keep elapsed time below one second between calls while the TTL advances.
					now = seededAt + (rate - 1) * 1000 + attempt * 250;
					if (atThreshold) {
						replies.push({ statusCode: 503 });
					}
					const result = await game.notes(account);
					if (atThreshold) {
						assert.deepEqual(result, { success: false });
						const url = requests.at(-1).url;
						assert.equal(url.origin + url.pathname, game.config.url.notes);
					}
					else {
						assert.equal(result.success, true);
						assert.equal(result.data.stamina.currentStamina, projectedStamina);
						assert.deepEqual(result.data.assets, assets);
					}
					assert.equal(committedBytes.length, attempt + 1);
				}
				assert.equal(replies.length, 0);
				const noteRequests = requests.length - 2; // Discovery and the initial Notes request.
				assert.equal(noteRequests, atThreshold ? attempts : 0);
				const prefixedKey = `keyv:${key}`;
				assert.deepEqual(lookups.mock.calls.map(call => call.arguments), Array.from({ length: attempts }, () => [prefixedKey]));

				const reopenedCache = new Cache();
				const persisted = await reopenedCache.get(key);
				const elapsedSeconds = rate + attempts - 1;
				const expected = {
					...initialSnapshot,
					uid: account.uid,
					nickname: account.nickname,
					expires: seededAt,
					lastUpdate: now,
					stamina: {
						...initialSnapshot.stamina,
						currentStamina: projectedStamina,
						recoveryTime: Number(initialSnapshot.stamina.recoveryTime) - elapsedSeconds
					}
				};
				if (initialSnapshot.realm) {
					expected.realm = {
						...initialSnapshot.realm,
						recoveryTime: Number(initialSnapshot.realm.recoveryTime) - elapsedSeconds
					};
				}
				if (initialSnapshot.expedition) {
					expected.expedition = {
						...initialSnapshot.expedition,
						list: initialSnapshot.expedition.list.map(entry => ({
							...entry,
							remaining_time: Number(entry.remaining_time) - elapsedSeconds
						}))
					};
				}
				assert.deepEqual(persisted, expected);
				const { cache } = JSON.parse(readFileSync(filename, "utf8"));
				const [[storedKey, entry]] = cache;
				assert.equal(cache.length, 1);
				assert.equal(storedKey, prefixedKey);
				const deadline = seededAt + DataCache.keyvCacheExpiration;
				assert.equal(entry.expire, deadline);
				assert.deepEqual(JSON.parse(entry.value), { value: persisted, expires: deadline });
				const bytes = committedBytes.reduce((total, size) => total + size, 0);
				t.diagnostic(`${attempts} cache lookups, ${committedBytes.length} file saves / ${bytes} bytes, ${noteRequests} Notes requests, ${deadline - now} ms remaining TTL`);

				app.Cache = reopenedCache;
				now += 250;
				const requestsBeforeReopenCall = requests.length;
				if (atThreshold) {
					replies.push({ statusCode: 503 });
				}
				const afterReopen = await game.notes(account);
				if (atThreshold) {
					assert.deepEqual(afterReopen, { success: false });
				}
				else {
					assert.equal(afterReopen.success, true);
					assert.equal(afterReopen.data.stamina.currentStamina, projectedStamina);
				}
				assert.equal(requests.length - requestsBeforeReopenCall, Number(atThreshold));
				assert.equal(replies.length, 0);
				const reopenedSnapshot = await app.Cache.get(key);
				assert.equal(reopenedSnapshot.lastUpdate, now);
				assert.equal(reopenedSnapshot.stamina.currentStamina, projectedStamina);
				assert.deepEqual(await new Cache().get(key), reopenedSnapshot);
			}
			finally {
				process.chdir(previousDirectory);
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
};
