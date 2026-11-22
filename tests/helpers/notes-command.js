const assert = require("node:assert/strict");
const { createNotesConsumers, notesKey } = require("./notes-concurrency.js");

async function assertWeeklyNotesRendering ({ game, cache, replies, requests }, note, expected, cachedCases = []) {
	const { account, manualReplies, runManual, telegramMessages, runManualTelegram } = createNotesConsumers(game, replies);
	const key = notesKey(account);
	const channels = [
		["Discord", runManual, ({ field, value }) => {
			const [embed] = manualReplies.at(-1).embeds;
			assert.equal(embed.fields.find(entry => entry.name === field).value, value);
		}],
		["Telegram", runManualTelegram, ({ telegramSuffix }) => {
			const lines = telegramMessages.at(-1).split("\n");
			assert.deepEqual(lines.slice(-telegramSuffix.length), telegramSuffix);
		}]
	];

	for (const [channel, run, assertOutput] of channels) {
		const requestCount = requests.length;
		replies.push(note);
		await run();
		assertOutput(expected);
		assert.equal(requests.length, requestCount + 1, `${channel} starts with a cache miss`);

		const snapshot = cache.get(key);
		for (const { overrides, output = expected } of [{}, ...cachedCases]) {
			cache.set(key, JSON.parse(JSON.stringify({ ...snapshot, ...overrides })));
			await run();
			assertOutput(output);
			assert.equal(requests.length, requestCount + 1, `${channel} reuses the cached snapshot`);
		}
		await game.dataCache.invalidateCache(account);
	}

	assert.equal(manualReplies.length, 2 + cachedCases.length);
	assert.equal(telegramMessages.length, 2 + cachedCases.length);
}

module.exports = { assertWeeklyNotesRendering };
