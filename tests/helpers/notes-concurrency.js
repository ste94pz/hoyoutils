const assert = require("node:assert/strict");
const { test } = require("node:test");
const HoyoLab = require("../../hoyolab-modules/template.js");
const notesCommand = require("../../commands/notes/index.js");
const staminaCron = require("../../crons/stamina/index.js");

const notesKey = ({ platform, region, uid }) => `notes:${JSON.stringify([platform, region, String(uid)])}`;

const deferred = () => {
	let resolve;
	const promise = new Promise(done => {
		resolve = done;
	});
	return { promise, resolve };
};

const createNotesConsumers = (game, replies) => {
	const [account] = game.accounts;
	const { uid } = account;
	app.HoyoLab = HoyoLab;
	const manualReplies = [];
	const telegramMessages = [];
	const notifications = [];
	const discord = {
		createUserMention: () => "",
		send: async (embed, options) => notifications.push({ embed, options })
	};
	app.Platform = {
		get: id => {
			assert.equal(id, 2);
			return { send: async message => telegramMessages.push(message) };
		},
		getForAccount: () => [discord],
		getEmbedPlatforms: platforms => platforms
	};
	const runManual = () => notesCommand.run({
		platform: { id: 1 },
		interaction: { reply: async reply => manualReplies.push(reply) }
	}, account.platform, uid);
	const runManualTelegram = () => notesCommand.run({ platform: { id: 2 } }, account.platform, uid);
	const holdReply = (reply) => {
		const started = deferred();
		const response = deferred();
		replies.push(() => {
			started.resolve();
			return response.promise;
		});
		return { started: started.promise, release: () => response.resolve(reply) };
	};
	return { account, manualReplies, telegramMessages, notifications, runManual, runManualTelegram, holdReply };
};

const testStaminaNotesRace = (gameName, setup, card, noteWithStamina, assertNotesRequest) => {
	test(`${gameName} Notes: manual and stamina cron misses fetch independently and retain the newer snapshot`, { timeout: 5000 }, async (t) => {
		const { game, requests, replies, cache, writes } = await setup(t);
		replies.push(card());
		await game.login();
		const { account, manualReplies, notifications, runManual, holdReply } = createNotesConsumers(game, replies);
		const older = holdReply(noteWithStamina(40));
		const newer = holdReply(noteWithStamina(110));

		const manual = runManual();
		await older.started;
		const cron = staminaCron.code();
		await newer.started;
		assert.equal(requests.length, 3); // Login plus two Notes requests from one cold cache.
		assertNotesRequest(requests[1]);
		assertNotesRequest(requests[2]);
		assert.equal(writes.length, 0);

		newer.release();
		await cron;
		assert.equal(manualReplies.length, 0);
		assert.equal(cache.get(notesKey(account)).stamina.currentStamina, 110);
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].options.notificationType, "stamina");
		assert.match(notifications[0].embed.fields.find(field => field.name === "Stamina").value, /^110\//);

		older.release();
		await manual;
		assert.equal(manualReplies.length, 1);
		assert.match(manualReplies[0].embeds[0].fields[0].value, /^40\//);
		assert.deepEqual(writes.map(entry => entry.value.stamina.currentStamina), [110]);
		assert.equal(cache.get(notesKey(account)).stamina.currentStamina, 110);
		assert.equal(requests.length, 3);
	});
};

module.exports = { createNotesConsumers, notesKey, testStaminaNotesRace };
