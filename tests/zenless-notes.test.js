const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHttpHarness } = require("./helpers/http.js");
const { assertWeeklyNotesRendering } = require("./helpers/notes-command.js");
const { createNotesConsumers, notesKey, testStaminaNotesRace } = require("./helpers/notes-concurrency.js");
const testNotesThreshold = require("./helpers/notes-threshold.js");
const shopStatusCron = require("../crons/shop-status/index.js");
const staminaCron = require("../crons/stamina/index.js");
const Zenless = require("../hoyolab-modules/zenless/index.js");
const HoyoLab = require("../hoyolab-modules/template.js");
const HoyoDate = require("../object/date.js");
const RegionalTaskManager = require("../object/regional-task-manager.js");
const Platform = require("../platforms/template.js");

const cookie = "ltoken_v2=synthetic-token; ltuid_v2=synthetic-id; ltmid_v2=synthetic-mid; cookie_token_v2=synthetic-cookie-token; account_mid_v2=synthetic-account-mid; account_id_v2=synthetic-account-id";
const role = {
	game_id: 8,
	game_role_id: "synthetic-role",
	nickname: "Synthetic Proxy",
	region: "prod_gf_eu",
	level: 20,
	logo: "https://example.invalid/logo.png"
};
const card = (list = [{ game_id: 6 }, role]) => ({ body: { retcode: 0, data: { list } } });
const dailyNote = (overrides = {}) => ({
	body: { retcode: 0,
		data: {
			energy: { progress: { current: 40, max: 240 }, restore: 72000 },
			vitality: { current: 200, max: 400 },
			vhs_sale: { sale_state: "SaleStateDoing" },
			card_sign: "CardSignDone",
			bounty_commission: null,
			survey_points: null,
			coffee: null,
			weekly_task: null,
			...overrides
		} }
});

const setup = async (t, language, configuredCookie = cookie, accountOptions = {}) => {
	const harness = await createHttpHarness(t, { language });
	t.mock.method(Date, "now", () => 1800000000000);
	for (const name of ["info", "warn", "log"]) {
		app.Logger[name] = (...args) => harness.logs.push(args);
	}
	app.Error = class extends Error {
		constructor ({ message }) { super(message); }
	};
	app.Date = { now: () => Date.now() };
	const cache = new Map();
	const writes = [];
	app.Cache = {
		get: async (key) => structuredClone(cache.get(key)),
		set: async (entry) => {
			writes.push(structuredClone(entry));
			cache.set(entry.key, structuredClone(entry.value));
		},
		delete: async (key) => cache.delete(key)
	};
	const previousList = [...HoyoLab.list];
	t.after(() => {
		HoyoLab.list = previousList;
	});
	const game = new Zenless({ id: 1,
		data: [{
			cookie: configuredCookie,
			stamina: { check: true, threshold: 100, persistent: false },
			redeemCode: true,
			dailiesCheck: true,
			shopStatus: true,
			...accountOptions
		}]});
	app.HoyoLab = {
		getRegion: (region) => region === "prod_gf_tw" ? "TW/HK/MO" : "EU",
		errorMessage: HoyoLab.errorMessage
	};
	return { ...harness, game, cache, writes };
};

const assertRequest = (request, notes, language = "en-us", expectedCookie = cookie) => {
	assert.equal(request.url.origin, "https://sg-act-public-api.hoyolab.com");
	assert.equal(request.url.pathname, notes
		? "/event/game_record_zzz/api/zzz/note"
		: "/game_record/card/wapi/getGameRecordCard");
	assert.equal(request.method, "GET");
	assert.equal(request.body, undefined);
	assert.deepEqual(Object.fromEntries(request.url.searchParams), notes
		? { server: "prod_gf_eu", role_id: role.game_role_id }
		: { uid: "synthetic-id" });
	assert.equal(request.headers.cookie, expectedCookie);
	assert.equal(request.headers.origin, "https://act.hoyolab.com");
	assert.equal(request.headers.referer, "https://act.hoyolab.com/");
	assert.equal(request.headers.accept, "application/json, text/plain, */*");
	assert.equal(request.headers["x-rpc-client_type"], undefined);
	assert.equal(request.headers["x-rpc-platform"], 2);
	assert.equal(request.headers["x-rpc-app_version"], "4.21.0");
	assert.equal(request.headers["x-rpc-language"], language);
	assert.equal(request.headers["x-rpc-lang"], language);
	assert.equal(request.headers["x-rpc-env"], undefined);
	assert.equal(request.headers["x-requested-with"], "com.mihoyo.hoyolab");
	assert.match(request.headers["user-agent"], /Android.*wv.*miHoYoBBSOversea\/4\.21\.0/);
	for (const header of ["ds", "x-rpc-signgame", "x-rpc-page", "x-rpc-device_id", "x-rpc-device_fp"]) {
		assert.equal(request.headers[header], undefined, header);
	}
};

for (const language of [undefined, "it-it"]) {
	test(`discovery and Notes preserve account, parser and cache contracts (${language ?? "default"})`, async (t) => {
		const { game, requests, replies, writes } = await setup(t, language);
		replies.push(card(), dailyNote());
		assert.equal(await game.login(), undefined);
		assert.equal(game.accounts.length, 1);
		const [account] = game.accounts;
		assert.equal(account.uid, role.game_role_id);
		assert.equal(account.nickname, role.nickname);
		assert.equal(account.level, role.level);
		assert.equal(account.timezone, "EU");
		assert.equal(account.cookie, cookie);
		assert.equal(account.redeemCode, true);
		assert.equal(account.dailiesCheck, true);
		assert.equal(account.shop.check, true);
		assert.equal(account.assets.logo, role.logo);
		assert.equal(account.assets.notes, game.config.url.notes);
		assert.equal(account.stamina.fired, false);
		assert.equal(account.shop.fired, false);
		const result = await game.notes(account);
		assert.deepEqual(result, { success: true,
			data: {
				cardSign: "Completed",
				stamina: { currentStamina: 40, maxStamina: 240, recoveryTime: 72000 },
				dailies: { task: 200, maxTask: 400 },
				weeklies: { bounty: 0, bountyTotal: 0, surveyPoints: 0, surveyPointsTotal: 0 },
				weekliesPresence: { bounty: false, surveyPoints: false },
				shop: { state: "Open" },
				assets: { ...game.config.assets, logo: role.logo, color: 0xFF8300 }
			} });
		const { cardSign, stamina, dailies, weeklies, weekliesPresence, shop } = result.data;
		assert.deepEqual(writes, [{
			key: notesKey(account),
			expiry: 3600000,
			value: {
				uid: role.game_role_id,
				nickname: role.nickname,
				lastUpdate: Date.now(),
				expires: Date.now(),
				cardSign,
				stamina,
				dailies,
				weeklies,
				weekliesPresence,
				shop
			}
		}]);
		const cached = await game.notes(account);
		assert.equal(cached.success, true);
		assert.equal(cached.data.stamina.currentStamina, 40);
		assert.deepEqual(cached.data.assets, result.data.assets);
		assert.deepEqual(cached.data.dailies, result.data.dailies);
		assert.equal(requests.length, 2);
		assertRequest(requests[0], false, language);
		assertRequest(requests[1], true, language);
	});
}

test("discovery preserves the TW/HK/MO timezone mapping", async (t) => {
	const { game, replies } = await setup(t);
	replies.push(card([{ ...role, region: "prod_gf_tw" }]));
	await game.login();
	assert.equal(game.accounts[0].timezone, "SEA");
});

for (const [weekliesCheck, source] of [[false, "fresh"], [true, "fresh"], [undefined, "fresh"], [true, "cached"], [true, "legacy cache"]]) {
	test(`Zenless weekly reminders use complete pairs (${weekliesCheck ?? "omitted"}, ${source})`, async (t) => {
		const accountOptions = weekliesCheck === undefined ? {} : { weekliesCheck };
		const { game, requests, replies, logs, cache } = await setup(t, undefined, cookie, accountOptions);
		const legacy = source === "legacy cache";
		const prefetch = source !== "fresh";
		app.HoyoLab = HoyoLab;
		app.Date = HoyoDate;
		const timers = [];
		app.RegionalTaskManager = class extends RegionalTaskManager {
			constructor () {
				super({
					now: () => Date.parse("2026-11-22T20:00:00Z"),
					random: () => 0,
					setTimer: callback => timers.push(callback)
				});
			}
		};
		const embeds = [];
		const messages = [];
		t.mock.method(Platform, "getForAccount", () => [
			{ name: "webhook", createUserMention: () => "", send: (...args) => embeds.push(args) },
			{ name: "telegram", send: message => messages.push(message) }
		]);
		app.Platform = Platform;
		const cronPath = require.resolve("../crons/weeklies-reminder/index.js");
		t.after(() => delete require.cache[cronPath]);
		const cron = require(cronPath);
		replies.push(card(), dailyNote({
			bounty_commission: { num: 0, total: 3 },
			survey_points: { num: legacy ? 100 : null, total: 8000 }
		}));

		await game.login();
		const [account] = game.accounts;
		if (prefetch) {
			assert.equal((await game.notes(account)).success, true);
			const key = notesKey(account);
			const snapshot = JSON.parse(JSON.stringify(cache.get(key)));
			if (legacy) {
				delete snapshot.weekliesPresence;
			}
			cache.set(key, snapshot);
		}
		await cron.code();
		assert.equal(timers.length, 1);
		assert.equal(requests.length, prefetch ? 2 : 1);
		assertRequest(requests[0], false);
		await timers[0]();

		const expectedCalls = weekliesCheck === false ? 0 : 1;
		assert.equal(requests.length, 1 + expectedCalls, "login plus at most one Notes request");
		assert.equal(embeds.length, expectedCalls, "webhook reminders");
		assert.equal(messages.length, expectedCalls, "Telegram reminders");
		assert.equal(account.weekliesCheck, weekliesCheck);
		assert.equal(logs.some(([, message]) => message === "Reminder failed; waiting for the next window"), false);
		if (expectedCalls) {
			assertRequest(requests[1], true);
			assert.equal(embeds[0][1].notificationType, "weeklies");
			const [name, value, absent] = legacy
				? ["Survey Points", "100/8000", "Bounty Commission"]
				: ["Bounty Commission", "0/3", "Survey Points"];
			assert.deepEqual(embeds[0][0].fields.slice(3), [{ name, value, inline: true }]);
			assert.ok(messages[0].includes(`**${name}**: ${value}`));
			assert.ok(!messages[0].includes(absent));
		}
	});
}

for (const [name, response, message] of [
	["HTTP failure", { statusCode: 403 }, /Failed to login/],
	["API failure", { body: { retcode: -100 } }, /Failed to login/],
	["invalid list", { body: { retcode: 0, data: {} } }, /Invalid data object/],
	["no Zenless role", card([{ game_id: 6 }]), /No Zenless Zone Zero account/]
]) {
	test(`discovery rejects ${name}`, async (t) => {
		const { game, replies, requests } = await setup(t);
		replies.push(response);
		await assert.rejects(game.login(), message);
		assert.deepEqual(game.accounts, []);
		assert.equal(requests.length, 1);
		assertRequest(requests[0], false);
	});
}

for (const [name, response, message] of [
	["private Notes", { body: { retcode: 10102, message: "Data is not public for the user" } }, /HoyoLab returned non-zero retcode/],
	["HTTP failure", { statusCode: 403 }, /Failed to fetch data/],
	["API failure", { body: { retcode: -100 } }, /HoyoLab returned non-zero retcode/],
	["quiet API failure", { body: { retcode: -501000 } }, null]
]) {
	test(`Notes handles ${name} without caching or privacy mutations`, async (t) => {
		const { game, replies, requests, logs, writes } = await setup(t);
		replies.push(card(), response);
		await game.login();
		logs.length = 0;
		assert.deepEqual(await game.notes(game.accounts[0]), { success: false });
		assert.equal(writes.length, 0);
		assert.equal(requests.length, 2);
		assertRequest(requests[1], true);
		const errors = logs.filter(([, details]) => typeof details === "object");
		if (message) {
			assert.equal(errors.length, 1);
			assert.match(errors[0][1].message, message);
		}
		else {
			assert.equal(errors.length, 0);
		}
		assert.equal(JSON.stringify(logs).includes("synthetic-token"), false);
	});
}

for (const [name, overrides] of [
	["stamina threshold", { energy: { progress: { current: 100, max: 240 }, restore: 50400 } }],
	["finished shop", { vhs_sale: { sale_state: "SaleStateDone" } }]
]) {
	test(`Notes refreshes cache for ${name}`, async (t) => {
		const { game, replies, requests } = await setup(t);
		replies.push(card(), dailyNote(overrides), dailyNote());
		await game.login();
		const [account] = game.accounts;
		await game.notes(account);
		const result = await game.notes(account);
		assert.equal(result.data.shop.state, "Open");
		assert.equal(result.data.stamina.currentStamina, 40);
		assert.equal(requests.length, 3);
		assertRequest(requests[2], true);
	});
}

test("Notes forwards the complete supplied cookie, including fields outside the legacy whitelist", async (t) => {
	const { game, replies, requests } = await setup(t);
	replies.push(card(), dailyNote());
	await game.login();
	const [account] = game.accounts;
	account.cookie += "; synthetic_extra=synthetic-value";
	await game.notes(account);
	assertRequest(requests[1], true, "en-us", account.cookie);
});

for (const [name, response, expected] of [
	["null data", { body: { retcode: 0, data: null } }, { success: false, error: "No data received from API" }],
	["null energy", dailyNote({ energy: null }), { success: false }],
	["null vitality", dailyNote({ vitality: null }), { success: false }],
	["missing energy", dailyNote({ energy: undefined }), { success: false }],
	["missing vitality", dailyNote({ vitality: undefined }), { success: false }]
]) {
	test(`Notes rejects ${name} without cache writes`, async (t) => {
		const { game, replies, requests, writes } = await setup(t);
		replies.push(card(), response);
		await game.login();
		assert.deepEqual(await game.notes(game.accounts[0]), expected);
		assert.equal(writes.length, 0);
		assert.equal(requests.length, 2);
		assertRequest(requests[1], true);
	});
}

test("Notes preserves a missing shop in the fresh response and cache hit", async (t) => {
	const { game, replies, requests, writes } = await setup(t);
	replies.push(card(), dailyNote({ vhs_sale: undefined }));
	await game.login();
	const [account] = game.accounts;

	const fresh = await game.notes(account);
	assert.equal(fresh.success, true);
	assert.equal(fresh.data.shop, null);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].value.shop, null);

	const cached = await game.notes(account);
	assert.equal(cached.success, true);
	assert.equal(cached.data.shop, null);
	assert.equal(requests.length, 2);
	assertRequest(requests[1], true);
});

test("Zenless Notes preserves weekly pair presence while keeping zero defaults for display", async (t) => {
	const { game, replies, requests, writes, cache } = await setup(t);
	replies.push(card(), dailyNote({
		bounty_commission: { total: 3 },
		survey_points: undefined
	}), dailyNote({
		bounty_commission: { num: 0, total: 3 },
		survey_points: { num: 0, total: 0 }
	}));
	await game.login();
	const [account] = game.accounts;
	const expected = { bounty: 0, bountyTotal: 3, surveyPoints: 0, surveyPointsTotal: 0 };

	for (const [fetchCount, present] of [[2, false], [3, true]]) {
		const expectedPresence = { bounty: present, surveyPoints: present };
		const fresh = await game.notes(account);
		assert.equal(fresh.success, true);
		assert.deepEqual(fresh.data.weeklies, expected);
		assert.deepEqual(fresh.data.weekliesPresence, expectedPresence);
		const { key, value } = writes.at(-1);
		assert.deepEqual(value.weeklies, expected);
		assert.deepEqual(value.weekliesPresence, expectedPresence);
		cache.set(key, JSON.parse(JSON.stringify(value)));
		const cached = await game.notes(account);
		assert.deepEqual(cached.data.weeklies, expected);
		assert.deepEqual(cached.data.weekliesPresence, expectedPresence);
		assert.equal(requests.length, fetchCount);
		await game.dataCache.invalidateCache(account);
	}
});

for (const [name, weeklyFields, lines] of [
	["absent or null pairs", {
		survey_points: undefined
	}, ["Bounty Commission: Not available", "Survey Points: Not available"]],
	["partial pairs", {
		bounty_commission: { total: 3 },
		survey_points: { num: 0, total: null }
	}, ["Bounty Commission: Not available", "Survey Points: Not available"]],
	["explicit zero", {
		bounty_commission: { num: 0, total: 3 },
		survey_points: { num: 0, total: 0 }
	}, ["Bounty Commission: 0/3", "Survey Points: 0/0"]]
]) {
	test(`Zenless /notes renders weekly objectives with ${name} on both platforms`, async (t) => {
		const harness = await setup(t);
		harness.replies.push(card());
		await harness.game.login();
		await assertWeeklyNotesRendering(harness, dailyNote(weeklyFields), {
			field: "Weeklies",
			value: lines.join("\n"),
			telegramSuffix: [...lines, "Shop Status: Open", "Howl Scratch Card: Completed"]
		});
	});
}

test("Zenless /notes keeps nonzero pairs in snapshots without presence markers", async (t) => {
	const harness = await setup(t);
	harness.replies.push(card());
	await harness.game.login();
	const expected = (bounty, surveyPoints) => {
		const lines = [`Bounty Commission: ${bounty}`, `Survey Points: ${surveyPoints}`];
		return {
			field: "Weeklies",
			value: lines.join("\n"),
			telegramSuffix: [...lines, "Shop Status: Open", "Howl Scratch Card: Completed"]
		};
	};
	await assertWeeklyNotesRendering(harness, dailyNote({
		bounty_commission: { num: 0, total: 3 },
		survey_points: { num: 100, total: 8000 }
	}), expected("0/3", "100/8000"), [
		{
			overrides: { weekliesPresence: undefined },
			output: expected("Not available", "100/8000")
		},
		{
			overrides: { weekliesPresence: undefined, weeklies: { bounty: 2, bountyTotal: 3, surveyPoints: 100, surveyPointsTotal: 0 } },
			output: expected("2/3", "Not available")
		}
	]);
});

test("Notes preserves populated weekly totals and scratch card/shop states", async (t) => {
	const { game, replies } = await setup(t);
	replies.push(card(), dailyNote({
		bounty_commission: { num: 2, total: 3 },
		survey_points: { num: 100, total: 8000 },
		card_sign: "CardSignNo",
		vhs_sale: { sale_state: "SaleStateNo" }
	}));
	await game.login();
	const result = await game.notes(game.accounts[0]);
	assert.deepEqual(result.data.weeklies, { bounty: 2, bountyTotal: 3, surveyPoints: 100, surveyPointsTotal: 8000 });
	assert.equal(result.data.cardSign, "Not Completed");
	assert.equal(result.data.shop.state, "Closed");
});

for (const [platformId, shopState] of [[1, "Open"], [2, "Open"], [1, "Not available"], [2, "Not available"]]) {
	test(`Notes command renders nullable weekly data and shop status ${shopState} on platform ${platformId}`, async (t) => {
		const { game, replies, requests } = await setup(t);
		replies.push(card(), shopState === "Open" ? dailyNote() : dailyNote({ vhs_sale: null }));
		await game.login();
		Object.assign(app.HoyoLab, {
			supportedGames: () => ["nap"],
			getActiveAccounts: () => game.accounts,
			get: () => game
		});
		app.Utils = { formatTime: () => "synthetic time", escapeCharacters: value => value };
		const sent = [];
		app.Platform = { get: () => ({ send: async message => sent.push(message) }) };
		const context = { platform: { id: platformId } };
		if (platformId === 1) {
			context.interaction = { reply: async message => sent.push(message) };
		}
		await require("../commands/notes/index.js").run(context, "zzz");
		assert.equal(sent.length, 1);
		if (platformId === 1) {
			const [embed] = sent[0].embeds;
			assert.equal(embed.color, 0xFF8300);
			assert.match(embed.fields[0].value, /^40\/240/);
			assert.equal(embed.fields.find(field => field.name === "Dailies").value, "200/400");
			assert.equal(embed.fields.find(field => field.name === "Weeklies").value, "Bounty Commission: Not available\nSurvey Points: Not available");
			assert.equal(embed.fields.find(field => field.name === "Shop Status").value, shopState);
			assert.equal(embed.fields.find(field => field.name === "Scratch Card").value, "Completed");
		}
		else {
			assert.match(sent[0], /Current Stamina: 40\/240/);
			assert.match(sent[0], /Dailies: 200\/400\nBounty Commission: Not available\nSurvey Points: Not available/);
			assert.ok(sent[0].endsWith(`\nShop Status: ${shopState}\nHowl Scratch Card: Completed`));
		}
		assert.equal(requests.length, 2);
		assertRequest(requests[1], true);
	});
}

const noteWithStamina = current => dailyNote({ energy: { progress: { current, max: 240 }, restore: 72000 } });
testNotesThreshold("ZZZ", setup, card, noteWithStamina, request => assertRequest(request, true));
testStaminaNotesRace("ZZZ", setup, card, noteWithStamina, request => assertRequest(request, true));

const rotatedTokens = [
	{ token_type: 2, token: "synthetic-rotated-ltoken" },
	{ token_type: 4, token: "synthetic-rotated-cookie-token" }
];
const rotatedCookie = cookie.replace("ltoken_v2=synthetic-token", "ltoken_v2=synthetic-rotated-ltoken")
	.replace("cookie_token_v2=synthetic-cookie-token", "cookie_token_v2=synthetic-rotated-cookie-token")
	.replace("account_mid_v2=synthetic-account-mid", "account_mid_v2=synthetic-mid")
	.replace("account_id_v2=synthetic-account-id", "account_id_v2=synthetic-id");

for (const refreshSucceeds of [true, false]) {
	const outcome = refreshSucceeds ? "rotates credentials" : "rejects the refresh";
	test(`ZZZ Notes: a lone in-flight response preserves its result when Passport ${outcome}`, { timeout: 5000 }, async (t) => {
		const { game, requests, replies, cache, writes } = await setup(t, undefined, `${cookie}; stoken=synthetic-refresh`);
		replies.push(card());
		await game.login();
		const { account, manualReplies, runManual, holdReply } = createNotesConsumers(game, replies);
		const pendingReply = holdReply(dailyNote());
		const manual = runManual();
		await pendingReply.started;
		assertRequest(requests[1], true);

		replies.push({ body: refreshSucceeds
			? { retcode: 0, data: { tokens: rotatedTokens } }
			: { retcode: -100, message: "Synthetic rejection" } });
		assert.equal(await HoyoLab.refreshStoredCookies(cookie), refreshSucceeds);
		assert.equal(requests.length, 3);
		assert.equal(requests[2].url.pathname, "/account/ma-passport/token/getBySToken");
		assert.equal(account.cookie, refreshSucceeds ? rotatedCookie : cookie);

		pendingReply.release();
		await manual;
		assert.equal(manualReplies.length, 1);
		assert.match(manualReplies[0].embeds[0].fields[0].value, /^40\//);
		const key = notesKey(account);
		assert.equal(cache.get(key)?.stamina.currentStamina, refreshSucceeds ? undefined : 40);
		assert.equal(writes.filter(entry => entry.key === key).length, refreshSucceeds ? 0 : 1);

		if (refreshSucceeds) {
			replies.push(noteWithStamina(70));
			const result = await game.notes(account);
			assert.equal(requests.length, 4);
			assertRequest(requests[3], true, "en-us", rotatedCookie);
			assert.equal(result.data.stamina.currentStamina, 70);
			assert.equal(cache.get(key).stamina.currentStamina, 70);
		}
	});
}

test("ZZZ Notes: Passport rotation during a manual fetch gives the stamina cron new credentials", { timeout: 5000 }, async (t) => {
	const { game, requests, replies, cache, writes } = await setup(t, undefined, `${cookie}; stoken=synthetic-refresh`);
	replies.push(card());
	await game.login();
	const { account, manualReplies, notifications, runManual, holdReply } = createNotesConsumers(game, replies);
	const manualReply = holdReply(dailyNote());
	const manual = runManual();
	await manualReply.started;

	replies.push({ body: { retcode: 0, data: { tokens: rotatedTokens } } });
	assert.equal(await HoyoLab.refreshStoredCookies(cookie), true);
	assert.equal(requests[2].method, "POST");
	assert.equal(requests[2].url.pathname, "/account/ma-passport/token/getBySToken");
	const cronReply = holdReply(noteWithStamina(110));
	const cron = staminaCron.code();
	await cronReply.started;
	assert.equal(requests.length, 4);
	assertRequest(requests[1], true);
	assertRequest(requests[3], true, "en-us", rotatedCookie);
	cronReply.release();
	await cron;
	assert.equal(manualReplies.length, 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].options.notificationType, "stamina");
	assert.match(notifications[0].embed.fields.find(field => field.name === "Stamina").value, /^110\//);
	manualReply.release();
	await manual;
	assert.match(manualReplies[0].embeds[0].fields[0].value, /^40\//);
	assert.deepEqual(writes.filter(entry => entry.key === notesKey(account)).map(entry => entry.value.stamina.currentStamina), [110]);
	assert.equal(cache.get(notesKey(account)).stamina.currentStamina, 110);
	assert.equal(requests.length, 4);
});

test("ZZZ Notes: shop cron invalidation prevents an in-flight manual fetch from repopulating the cache", { timeout: 5000 }, async (t) => {
	const { game, requests, replies, cache, writes } = await setup(t);
	replies.push(card(), noteWithStamina(100));
	await game.login();
	const { account, manualReplies, notifications, runManual, holdReply } = createNotesConsumers(game, replies);
	await game.notes(account);

	const manualReply = holdReply(dailyNote());
	const shopReply = holdReply(dailyNote({ vhs_sale: { sale_state: "SaleStateDone" } }));
	const manual = runManual();
	await manualReply.started;
	assert.equal(cache.get(notesKey(account)).stamina.currentStamina, 100);

	const cron = shopStatusCron.code();
	await shopReply.started;
	assert.equal(cache.has(notesKey(account)), false);
	assert.equal(requests.length, 4); // Login, seed, manual request and forced refresh.
	assertRequest(requests[2], true);
	assertRequest(requests[3], true);
	assert.deepEqual(requests[2], requests[3]);

	const priorWriteCount = writes.length;
	manualReply.release();
	await manual;
	assert.equal(cache.has(notesKey(account)), false);
	assert.equal(manualReplies.length, 1);
	assert.equal(manualReplies[0].embeds[0].fields.find(field => field.name === "Shop Status").value, "Open");
	assert.equal(notifications.length, 0);

	shopReply.release();
	await cron;
	assert.deepEqual(writes.slice(priorWriteCount).map(entry => entry.value.shop.state), ["Finished"]);
	assert.equal(cache.get(notesKey(account)).shop.state, "Finished");
	assert.equal(account.shop.fired, true);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].options.notificationType, "shopStatus");
	assert.equal(requests.length, 4);
});

test("ZZZ Notes: a manual miss after shop invalidation can finish before the forced fetch", { timeout: 5000 }, async (t) => {
	const { game, requests, replies, cache, writes } = await setup(t);
	replies.push(card(), dailyNote());
	await game.login();
	const { account, manualReplies, notifications, runManual, holdReply } = createNotesConsumers(game, replies);
	await game.notes(account);
	const shopReply = holdReply(dailyNote({ vhs_sale: { sale_state: "SaleStateDone" } }));
	const manualReply = holdReply(dailyNote());
	const cron = shopStatusCron.code();
	await shopReply.started;
	assert.equal(cache.has(notesKey(account)), false);
	const manual = runManual();
	await manualReply.started;
	assert.equal(requests.length, 4);
	assertRequest(requests[2], true);
	assert.deepEqual(requests[2], requests[3]);

	manualReply.release();
	await manual;
	assert.equal(manualReplies[0].embeds[0].fields.find(field => field.name === "Shop Status").value, "Open");
	assert.equal(notifications.length, 0);
	shopReply.release();
	await cron;
	assert.equal(account.shop.fired, true);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].options.notificationType, "shopStatus");
	assert.deepEqual(writes.map(entry => entry.value.shop.state), ["Open", "Open"]);
	assert.equal(cache.get(notesKey(account)).shop.state, "Open");
	assert.equal(requests.length, 4);
});

test("ZZZ Notes: shop refresh affects only the selected region when role IDs match", { timeout: 5000 }, async t => {
	const { game, requests, replies, cache } = await setup(t);
	game.data[0].shopStatus = false;
	game.data.push({ ...game.data[0], shopStatus: true, stamina: { ...game.data[0].stamina, threshold: 150 } });
	replies.push(card(), card([{ ...role, region: "prod_gf_jp" }]), noteWithStamina(65), noteWithStamina(110));
	await game.login();
	const [europe, asia] = game.accounts;
	const { notifications, holdReply } = createNotesConsumers(game, replies);
	assert.equal(europe.uid, asia.uid);
	await game.notes(europe);
	await game.notes(asia);
	assert.equal(cache.get(notesKey(europe)).stamina.currentStamina, 65);
	assert.equal(cache.get(notesKey(asia)).stamina.currentStamina, 110);

	// Only the Asian account's threshold admits this cached sample.
	const warmAsia = await game.notes(asia);
	assert.equal(warmAsia.success, true);
	assert.ok(warmAsia.data.stamina.currentStamina >= 110);
	assert.equal(requests.length, 4);

	const refreshed = holdReply(dailyNote({ vhs_sale: { sale_state: "SaleStateDone" } }));
	const cron = shopStatusCron.code();
	await refreshed.started;
	assert.equal(cache.has(notesKey(asia)), false);
	assert.equal(cache.get(notesKey(europe)).stamina.currentStamina, 65);
	assert.equal(requests[4].url.searchParams.get("server"), asia.region);

	const warmEurope = await game.notes(europe);
	assert.equal(warmEurope.success, true);
	assert.ok(warmEurope.data.stamina.currentStamina >= 65);
	refreshed.release();
	await cron;
	assert.equal(cache.get(notesKey(asia)).shop.state, "Finished");
	assert.equal(cache.get(notesKey(europe)).shop.state, "Open");
	assert.deepEqual(game.accounts, [europe, asia]);
	assert.equal(europe.shop.fired, false);
	assert.equal(asia.shop.fired, true);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].options.notificationType, "shopStatus");
	assert.equal(requests.length, 5);
});

test("ZZZ Notes: an absent shop preserves notification state and the cron continues", async t => {
	const { game, requests, replies, cache } = await setup(t);
	game.data.push({ ...game.data[0] });
	const secondRole = { ...role, region: "prod_gf_jp" };
	const finished = dailyNote({ vhs_sale: { sale_state: "SaleStateDone" } });
	replies.push(card(), card([secondRole]), dailyNote(), dailyNote());
	await game.login();
	const [first, second] = game.accounts;
	first.shop.fired = true;
	const { notifications } = createNotesConsumers(game, replies);
	await game.notes(first);
	await game.notes(second);
	const update = t.mock.method(game, "update");

	replies.push(dailyNote({ vhs_sale: null }), finished);
	await shopStatusCron.code();
	assert.deepEqual(requests.slice(4).map(request => request.url.searchParams.get("server")), [first.region, second.region]);
	assert.equal(cache.get(notesKey(first)).shop, null);
	assert.equal(cache.get(notesKey(second)).shop.state, "Finished");
	assert.equal(first.shop.fired, true);
	assert.equal(second.shop.fired, true);
	assert.deepEqual(update.mock.calls.map(call => call.arguments[0]), [second]);
	assert.deepEqual(notifications.map(({ options }) => options.notificationType), ["shopStatus"]);

	replies.push(finished, finished);
	await shopStatusCron.code();
	assert.equal(update.mock.callCount(), 1);
	assert.equal(notifications.length, 1);

	replies.push(dailyNote({ vhs_sale: { sale_state: "SaleStateNo" } }), dailyNote());
	await shopStatusCron.code();
	assert.equal(first.shop.fired, false);
	assert.equal(second.shop.fired, false);
	assert.deepEqual(update.mock.calls.map(call => call.arguments[0]), [second, first, second]);
	assert.equal(notifications.length, 1);
});
