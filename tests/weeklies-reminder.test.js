const assert = require("node:assert/strict");
const test = require("node:test");
const HoyoDate = require("../object/date.js");
const RegionalTaskManager = require("../object/regional-task-manager.js");
const Platform = require("../platforms/template.js");
const Utils = require("../singleton/utils.js");
const { setLanguage } = require("../localization/index.js");

const cronPath = require.resolve("../crons/weeklies-reminder/index.js");

test("weekly reminders skip unsupported games and continue through supported accounts", async (t) => {
	const previousApp = global.app;
	t.after(() => {
		global.app = previousApp;
		delete require.cache[cronPath];
	});
	const accounts = ["tot", "honkai", "genshin", "starrail", "nap"].map(platform => ({
		platform, uid: platform, timezone: 0
	}));
	const notesCalls = [];
	const updated = [];
	let now = Date.parse("2026-11-08T21:00:00Z");
	const timers = [];
	const cache = new Map();
	const fireTimers = async () => {
		for (const callback of timers.splice(0)) {
			await callback();
		}
	};
	global.app = {
		RegionalTaskManager: class extends RegionalTaskManager {
			constructor () {
				super({ now: () => now, random: () => 0, setTimer: callback => timers.push(callback) });
			}
		},
		Cache: {
			get: async key => structuredClone(cache.get(key)),
			set: async ({ key, value }) => cache.set(key, structuredClone(value))
		},
		Date: class extends Date {
			constructor (value = "2026-11-08T21:00:00Z") { super(value); }
			get hours () { return 21; }
			setTimezoneOffset () {}
		},
		Logger: { debug () {}, error: assert.fail },
		HoyoLab: {
			getActiveAccounts: ({ blacklist = []} = {}) => accounts.filter(account => !blacklist.includes(account.platform)),
			get: platform => ({
				notes: async () => {
					assert.ok(!["tot", "honkai"].includes(platform), "unsupported Notes must not be called");
					notesCalls.push(platform);
					return { success: false };
				},
				update: account => updated.push(account.platform)
			})
		}
	};
	delete require.cache[cronPath];
	const cron = require(cronPath);
	await cron.code();
	assert.equal(notesCalls.length, 0);
	assert.equal(timers.length, 3);
	await fireTimers();
	assert.deepEqual(notesCalls, ["genshin", "starrail", "nap"]);
	assert.deepEqual(updated, ["genshin", "starrail", "nap"]);
	assert.equal(accounts[0].lastWeekliesReminderExecution, undefined);
	assert.equal(accounts[1].lastWeekliesReminderExecution, undefined);

	// Preserve the existing per-day deduplication and disabled-account behavior.
	await cron.code();
	await fireTimers();
	assert.equal(notesCalls.length, 3);
	now += 7 * 86400000;
	for (const account of accounts) {
		delete account.lastWeekliesReminderExecution;
		account.weekliesCheck = false;
	}
	await cron.code();
	await fireTimers();
	assert.equal(notesCalls.length, 3);
});

const starRailComplete = {
	weeklyBoss: 0,
	weeklyBossLimit: 3,
	rogueScore: 14000,
	maxScore: 14000,
	tournScore: 12000,
	tournMaxScore: 12000,
	tournUnlocked: true
};
const zenlessComplete = { bounty: 3, bountyTotal: 3, surveyPoints: 8000, surveyPointsTotal: 8000 };
// An array is the rendered progress. false suppresses delivery.
const scenarios = {
	genshin: [
		["resin discounts available", { resinDiscount: 2, resinDiscountLimit: 3 }, [["Resin Discount", "2/3 Available"]]],
		["no resin discounts remaining", { resinDiscount: 0, resinDiscountLimit: 3 }, []],
		["remaining discounts with null limit", { resinDiscount: 2, resinDiscountLimit: null }, false],
		["zero remaining discounts with missing limit", { resinDiscount: 0 }, false],
		["discount count given as text", { resinDiscount: "2", resinDiscountLimit: 3 }, false],
		["weekly fields absent", {}, false],
		["weeklies absent", undefined, false]
	],
	starrail: [
		["boss attempts remaining", { ...starRailComplete, weeklyBoss: 2 }, [["Weekly Boss", "2/3 Completed"]]],
		["Simulated Universe below target", { ...starRailComplete, rogueScore: 5000 }, [["Simulated Universe", "5000/14000"]]],
		["Divergent Universe below target with no unlock flag", { ...starRailComplete, tournScore: 4000, tournUnlocked: undefined }, [["Divergent Universe", "4000/12000"]]],
		["Divergent Universe locked at target", { ...starRailComplete, tournUnlocked: false }, [["Divergent Universe", "12000/12000"]]],
		["Divergent Universe with missing unlock flag at target", { ...starRailComplete, tournUnlocked: undefined }, false],
		["Divergent Universe with null unlock flag at target", { ...starRailComplete, tournUnlocked: null }, false],
		["Divergent Universe locked but without a score", { ...starRailComplete, tournScore: null, tournUnlocked: false }, false],
		[
			"known Simulated Universe progress with missing boss count",
			{ ...starRailComplete, weeklyBoss: undefined, rogueScore: 5000 },
			[["Simulated Universe", "5000/14000"]]
		],
		["all objectives complete", starRailComplete, false],
		["weekly fields absent", {}, false],
		["weeklies absent", undefined, false]
	],
	nap: [
		["bounty commission below target", { ...zenlessComplete, bounty: 2 }, [["Bounty Commission", "2/3"]]],
		["survey points below target", { ...zenlessComplete, surveyPoints: 100 }, [["Survey Points", "100/8000"]]],
		["all objectives complete", zenlessComplete, false],
		["weekly fields defaulted to zero in a legacy snapshot", { bounty: 0, bountyTotal: 0, surveyPoints: 0, surveyPointsTotal: 0 }, false],
		["zero count with positive total in a legacy snapshot", { bounty: 0, bountyTotal: 3, surveyPoints: 0, surveyPointsTotal: 0 }, false],
		["zero total with a positive count in a legacy snapshot", { ...zenlessComplete, bounty: 2, bountyTotal: 0 }, false],
		["legacy snapshot with one usable objective", { ...zenlessComplete, bounty: 0, surveyPoints: 100 }, [["Survey Points", "100/8000"]]],
		["explicit zero and missing survey count", { ...zenlessComplete, bounty: 0, surveyPoints: 0 }, [["Bounty Commission", "0/3"]], { bounty: true, surveyPoints: false }],
		["missing bounty count and explicit zero survey points", { ...zenlessComplete, bounty: 0, surveyPoints: 0 }, [["Survey Points", "0/8000"]], { bounty: false, surveyPoints: true }],
		["null weeklies", null, false],
		["weeklies absent", undefined, false]
	]
};

async function runReminder (t, type, weeklies, channels, { weekliesPresence, failDelivery = false } = {}) {
	const now = Date.parse("2026-11-08T21:00:00Z");
	const account = { platform: type, uid: "synthetic-role", region: "synthetic-region", nickname: "Player", timezone: 0 };
	const data = { assets: { color: 123, author: "Game", logo: "https://example.invalid/logo.png" } };
	if (weeklies !== undefined) {
		data.weeklies = weeklies;
	}
	if (weekliesPresence !== undefined) {
		data.weekliesPresence = weekliesPresence;
	}
	const events = [];
	const sent = new Map();
	const timers = [];
	const cache = new Map();
	const errors = [];
	const destinations = channels.map(name => ({
		name,
		createUserMention: () => "mention",
		send: async (...args) => {
			events.push(name);
			if (failDelivery) {
				throw new Error("Synthetic delivery failure");
			}
			sent.set(name, args);
		}
	}));
	const previousApp = global.app;
	t.after(() => {
		global.app = previousApp;
		delete require.cache[cronPath];
	});
	global.app = {
		RegionalTaskManager: class extends RegionalTaskManager {
			constructor () {
				super({ now: () => now, random: () => 0, setTimer: callback => timers.push(callback) });
			}
		},
		Cache: {
			get: async key => structuredClone(cache.get(key)),
			set: async ({ key, value, durable }) => {
				assert.equal(durable, true);
				cache.set(key, structuredClone(value));
				events.push(value.attemptedDate ? "attempt" : "schedule");
			}
		},
		Date: HoyoDate,
		Logger: { debug () {}, error: (...args) => errors.push(args) },
		HoyoLab: {
			getActiveAccounts: () => [account],
			get: () => ({
				type,
				notes: async () => {
					events.push("notes");
					return { success: true, data };
				},
				update: updated => {
					assert.equal(updated, account);
					events.push("update");
				}
			}),
			getRegion: region => region
		},
		Platform: { getForAccount: () => destinations, getEmbedPlatforms: Platform.getEmbedPlatforms },
		Utils: new Utils()
	};
	const cron = require(cronPath);
	await cron.code();
	assert.equal(timers.length, 1);
	assert.deepEqual(events, ["schedule"]);
	await timers.shift()();
	assert.equal(cache.size, 1);
	const [state] = cache.values();
	assert.equal(state.attemptedDate, "2026-11-8");
	await cron.code();
	assert.equal(timers.length, 0, "same-day poll cannot schedule a second attempt");
	return {
		events,
		sent,
		errors,
		execution: account.lastWeekliesReminderExecution,
		expectedExecution: new HoyoDate(now).setTimezoneOffset(account.timezone).toISOString()
	};
}

for (const [type, cases] of Object.entries(scenarios)) {
	for (const [name, weeklies, progress, weekliesPresence] of cases) {
		for (const channels of [["telegram"], ["webhook"], ["webhook", "telegram"]]) {
			test(`weekly reminders for ${type} with ${name} on ${channels.join(" and ")}`, async (t) => {
				const result = await runReminder(t, type, weeklies, channels, { weekliesPresence });
				const expectedChannels = Array.isArray(progress) ? channels : [];
				assert.deepEqual([...result.sent.keys()], expectedChannels);
				assert.deepEqual(result.events, ["schedule", "attempt", "notes", ...expectedChannels, "update"]);
				assert.deepEqual(result.errors, []);
				assert.equal(result.execution, result.expectedExecution);
				if (result.sent.has("webhook")) {
					const [embed, options] = result.sent.get("webhook");
					assert.deepEqual(embed.fields.slice(3).map(({ name, value }) => [name, value]), progress);
					assert.equal(options.notificationType, "weeklies");
				}
				if (result.sent.has("telegram")) {
					const [message] = result.sent.get("telegram");
					const lines = message.split("\n");
					const heading = lines.indexOf("📊 **Progress**");
					assert.notEqual(heading, -1);
					assert.deepEqual(lines.slice(heading + 1), progress.map(([label, value]) => `\\- **${label}**: ${value}`));
				}
			});
		}
	}
}

test("weekly reminders preserve the attempted window when webhook delivery fails", async (t) => {
	const result = await runReminder(t, "genshin", { resinDiscount: 2, resinDiscountLimit: 3 }, ["webhook", "telegram"], { failDelivery: true });
	assert.deepEqual(result.events, ["schedule", "attempt", "notes", "webhook"]);
	assert.equal(result.sent.size, 0);
	assert.deepEqual(result.errors, [["RegionalTaskManager", "Reminder failed; waiting for the next window"]]);
	assert.equal(result.execution, undefined);
});

test("weekly reminders with no recipients record the execution even without weeklies", async (t) => {
	const result = await runReminder(t, "starrail", undefined, []);
	assert.deepEqual(result.events, ["schedule", "attempt", "notes", "update"]);
	assert.equal(result.sent.size, 0);
	assert.deepEqual(result.errors, []);
	assert.equal(result.execution, result.expectedExecution);
});

test("weekly reminders render multiple objectives in order in Italian on both channels", async (t) => {
	t.after(() => setLanguage("en-us"));
	setLanguage("it");
	const result = await runReminder(t, "starrail", {
		...starRailComplete,
		weeklyBoss: 2,
		rogueScore: 5000,
		tournScore: 4000
	}, ["webhook", "telegram"]);

	assert.deepEqual(result.events, ["schedule", "attempt", "notes", "webhook", "telegram", "update"]);
	const [embed] = result.sent.get("webhook");
	assert.deepEqual(embed.fields.slice(3), [
		{ name: "Boss settimanali", value: "2/3 completati", inline: true },
		{ name: "Universo simulato", value: "5000/14000", inline: true },
		{ name: "Universo divergente", value: "4000/12000", inline: true }
	]);
	const [message] = result.sent.get("telegram");
	assert.deepEqual(message.split("\n").slice(-4), [
		"📊 **Avanzamento**",
		"\\- **Boss settimanali**: 2/3 completati",
		"\\- **Universo simulato**: 5000/14000",
		"\\- **Universo divergente**: 4000/12000"
	]);
});
