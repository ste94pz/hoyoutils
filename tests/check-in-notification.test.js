const assert = require("node:assert/strict");
const { test } = require("node:test");
const command = require("../commands/checkin/index.js");
const cron = require("../crons/check-in/index.js");
const Platform = require("../platforms/template.js");
const Utils = require("../singleton/utils.js");

const genshin = {
	platform: "genshin",
	uid: "101",
	username: "Player_one",
	region: "Europe",
	rank: "60",
	award: { name: "Reward+", count: 2, icon: "reward-icon" },
	total: "3",
	result: "Signed in!",
	assets: { game: "Genshin Impact", author: "Genshin", logo: "genshin-icon", color: 0x123456 }
};

const themis = {
	...genshin,
	platform: "tot",
	uid: "102",
	username: "Unknown",
	rank: "N/A",
	assets: { game: "Tears of Themis", author: "Themis", logo: "themis-icon", color: 0xABCDEF }
};

const failure = {
	...themis,
	uid: "103",
	award: undefined,
	failed: true,
	result: "Check-in failed."
};

function setup (t, executions, accounts = [], mode) {
	const previousApp = global.app;
	const previousPlatforms = Platform.list;
	t.after(() => {
		global.app = previousApp;
		Platform.list = previousPlatforms;
	});
	const deliveries = [];
	Platform.list = ["discord", "telegram", "webhook", "gotify"].map((name, index) => ({
		id: index + 1,
		name,
		send: async (...args) => deliveries.push([name, ...args])
	}));
	global.app = {
		Config: { get: () => ({ checkIn: mode }) },
		Logger: { warn: assert.fail, error: assert.fail, info () {} },
		Utils: new Utils(),
		Platform,
		HoyoLab: {
			getActiveAccounts: () => accounts,
			getActivePlatform: () => Object.keys(executions),
			getAccountById: uid => accounts.find(account => account.uid === uid),
			get: name => ({ checkIn: async () => executions[name] })
		}
	};
	return deliveries;
}

const fields = (...rows) => rows.map(([name, value, inline = true]) => ({ name, value, inline }));

test("manual Discord replies are ephemeral and capped at ten embeds while webhook receives the full batch", async (t) => {
	const deliveries = setup(t, {
		genshin: new Array(10).fill(genshin),
		tot: [themis, failure]
	});
	const replies = [];
	const interaction = {
		deferReply: async reply => replies.push(reply),
		editReply: async reply => replies.push(reply)
	};
	assert.deepEqual(await command.run({ interaction, platform: Platform.get(1) }), { success: true });
	assert.deepEqual(replies[0], { ephemeral: true });
	assert.equal(replies.length, 2);
	assert.equal(replies[1].embeds.length, 10);
	assert.equal(deliveries.length, 12);
	assert.ok(deliveries.every(([name, , options]) => name === "webhook" && options.notificationType === "checkIn"));
	assert.deepEqual(replies[1].embeds, deliveries.slice(0, 10).map(([, embed]) => embed));

	const [, first, options] = deliveries[0];
	assert.deepEqual(first.fields, fields(
		["UID", "101"], ["Username", "Player_one"], ["Region", "Europe"], ["Rank", "60"], ["Today's Reward", "Reward+ x2"], ["Total Sign-ins", "3"], ["Result", "Signed in!"]
	));
	assert.equal(first.footer.text, "Manual Check-In (1/11)");
	assert.deepEqual(options, { author: "HoYoUtils", icon: "genshin-icon", notificationType: "checkIn" });

	const [, tot] = deliveries[10];
	assert.deepEqual(tot.fields, fields(
		["UID", "102"], ["Region", "Europe"], ["Today's Reward", "Reward+ x2"], ["Total Sign-ins", "3"], ["Result", "Signed in!"]
	));
	assert.equal(tot.footer.text, "Manual Check-In (11/11)");
	const [, error] = deliveries[11];
	assert.equal(error.title, "❌ Check-In Errors");
	assert.equal(error.description, "**Tears of Themis (103)**: Check-in failed.");
});

test("manual Telegram keeps the success details and sends a separate escaped error summary", async (t) => {
	const deliveries = setup(t, { tot: [themis, failure]});
	assert.deepEqual(await command.run({ platform: Platform.get(2) }), { success: true });
	assert.deepEqual(deliveries, [
		["telegram", [
			"🎮 **Tears of Themis** Manual Check\\-In",
			"🆔 **\\(102\\)** Unknown",
			"🌍 **Region:** Europe",
			"🏆 **Rank:** N/A",
			"🎁 **Today's Reward:** Reward\\+ x2",
			"📅 **Total Sign\\-ins:** 3",
			"📝 **Result:** Signed in\\!"
		].join("\n")],
		["telegram", "❌ Tears of Themis \\(103\\): Check\\-in failed\\."]
	]);
});

for (const [mode, destinations, failurePosition] of [
	[undefined, ["webhook", "telegram", "gotify", "telegram"], "3/3"],
	["all", ["webhook", "telegram", "gotify", "telegram"], "3/3"],
	["failures", ["gotify", "telegram"], "1/1"],
	["none", [], null]
]) {
	test(`scheduled check-in routes notifications in ${mode ?? "default"} mode`, async (t) => {
		const deliveries = setup(t, {
			genshin: [genshin],
			tot: [themis, failure]
		}, [
			{ uid: genshin.uid, allowedPlatforms: [1, 2, 3]},
			{ uid: themis.uid, allowedPlatforms: []},
			{ uid: failure.uid, allowedPlatforms: [2, 4]}
		], mode);
		await cron.code();

		assert.deepEqual(deliveries.map(([name]) => name), destinations);
		if (mode === "none") {
			return;
		}
		if (destinations.includes("webhook")) {
			const [, success] = deliveries[0];
			assert.deepEqual(success.thumbnail, { url: "reward-icon" });
			assert.equal(success.fields.at(-1).inline, true);
			assert.equal(success.footer.text, "HoYoUtils Check-In (1/3) Executed");
			assert.deepEqual(deliveries[1], ["telegram", [
				"🎮 **Genshin Impact** Daily Check\\-In",
				"🆔 **\\(101\\)** Player\\_one",
				"🌍 **Region:** Europe",
				"🏆 **Rank:** 60",
				"🎁 **Today's Reward:** Reward\\+ x2",
				"📅 **Total Sign\\-ins:** 3",
				"📝 **Result:** Signed in\\!"
			].join("\n")]);
		}
		const [, error, options] = deliveries.at(-2);
		assert.equal(error.title, "❌ Tears of Themis Check-In Failed");
		assert.equal(error.color, 0xFF0000);
		assert.equal(error.thumbnail, undefined);
		assert.equal(error.footer.text, `HoYoUtils Check-In (${failurePosition}) Executed`);
		assert.deepEqual(error.fields, fields(["UID", "103"], ["Region", "Europe"], ["Result", "Check-in failed.", false]));
		assert.deepEqual(options, { author: "Themis", icon: "themis-icon", notificationType: "checkIn" });
		assert.deepEqual(deliveries.at(-1), ["telegram", [
			"❌ **Tears of Themis** Check\\-In Failed",
			"🆔 **\\(103\\)** Unknown",
			"🌍 **Region:** Europe",
			"📝 **Result:** Check\\-in failed\\."
		].join("\n")]);
	});
}
