const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const timers = require("node:timers/promises");
const { runInNewContext } = require("node:vm");
const { createHttpHarness } = require("./helpers/http.js");
const HoyoLab = require("../hoyolab-modules/template.js");
const { buildMimoRequest } = require("../hoyolab-modules/mimo-request.js");

const cookie = "ltoken_v2=synthetic; ltuid_v2=123; ltmid_v2=mid; cookie_token_v2=cookie; account_id_v2=123; account_mid_v2=mid";
const account = { cookie: `${cookie}; unrelated=ignored`, uid: "role", redeemCode: true };
const ok = (data = {}) => ({ body: { retcode: 0, data } });
const setup = async (t, gameId = 6, language) => {
	const harness = await createHttpHarness(t, { language });
	for (const name of ["log", "info", "warn"]) {
		app.Logger[name] = (...args) => harness.logs.push(args);
	}
	app.HoyoLab = { parseCookie: HoyoLab.parseCookie, errorMessage: () => null };
	app.Date = { now: () => Date.now() };
	const cache = new Map();
	app.Cache = { get: async key => cache.get(key), set: async ({ key, value }) => cache.set(key, value) };
	const delays = [];
	t.mock.method(timers, "setTimeout", async ms => delays.push(ms));
	const path = require.resolve("../hoyolab-modules/mimo.js");
	delete require.cache[path];
	t.after(() => {
		delete require.cache[path];
	});
	const redeemed = [];
	const instance = { gameId,
		name: gameId === 6 ? "starrail" : "zenless",
		fullName: "Synthetic Game",
		config: { assets: {} },
		redeemCode: async (data, code) => {
			redeemed.push(code);
			return { success: true };
		} };
	return { ...harness, delays, redeemed, mimo: new (require(path))(instance) };
};

for (const gameId of [6, 8]) {
	for (const language of [undefined, "it-it"]) {
		test(`Mimo operation wire contracts game ${gameId}, locale ${language}`, async t => {
			const { mimo, replies, requests } = await setup(t, gameId, language);
			replies.push(ok({ list: [{ game_id: gameId, version_id: 999, point: 25 }]}), ok({ task_list: []}), ok(), ok(), ok({ exchange_award_list: []}), ...(language ? [ok({ exchange_award_list: []})] : []), ok({ exchange_code: "synthetic-code" }), ok({ point: 25, cost: 20, count: 0, limit_count: 1, award_list: []}), ok({ name: "Points x5", exchange_code: "", award_id: 7 }), ok({ list: [], total_count: 0 }));
			assert.equal((await mimo.getGameInfo(account)).data.versionId, 999);
			await mimo.getTasks(account, 999);
			await mimo.finishTask(account, 88, 999);
			await mimo.claimTaskReward(account, 88, 999);
			await mimo.getShopItems(account, 999);
			assert.deepEqual(await mimo.exchangeItem(account, 77, 999), { success: true, data: { code: "synthetic-code" } });
			await mimo.getLotteryInfo(account, 999);
			assert.deepEqual((await mimo.drawLottery(account, 999)).data, { name: "Points x5", code: "", rewardId: 7, type: undefined });
			await mimo.getShopPurchases(account, 999);
			// Non-English shop reads retain the upstream English policy-name lookup.
			if (language) {
				assert.equal(requests[5].url.searchParams.get("lang"), "en-us");
				requests.splice(5, 1);
			}
			const paths = ["index", "task-list", "finish-task", "receive-point", "exchange-list", "exchange", "lottery-info", "lottery", "point-record"];
			for (const [i, request] of requests.entries()) {
				const post = [2, 5, 7].includes(i);
				const lang = i === 8 ? "en-us" : language || "en-us";
				assert.equal(request.url.origin, "https://sg-public-api.hoyolab.com");
				assert.equal(request.url.pathname, `/event/e2023mimotravel/${paths[i]}`);
				assert.equal(request.method, post ? "POST" : "GET");
				const fields = { game_id: gameId,
					version_id: 999,
					...([2, 3].includes(i) ? { task_id: 88 } : {}),
					...(i === 5 ? { award_id: 77 } : {}) };
				assert.deepEqual(Object.fromEntries(request.url.searchParams), {
					lang,
					...(!post && i !== 0 ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])) : {}),
					...(i === 8 ? { operator_type: "2", page: "1", page_size: "100" } : {})
				});
				assert.deepEqual(request.body && JSON.parse(request.body), post ? { ...fields, lang } : undefined);
				assert.equal(request.headers.cookie, cookie);
				assert.match(request.headers["user-agent"], i < 4 ? /Android.*wv/ : /Windows NT/);
				assert.equal(request.headers["x-requested-with"], i < 4 ? "com.mihoyo.hoyolab" : undefined);
				for (const name of ["ds", "x-rpc-client_type", "x-rpc-app_version", "x-rpc-language", "x-rpc-platform", "x-rpc-device_id", "x-rpc-device_fp", "x-rpc-lrsag"]) {
					assert.equal(request.headers[name], undefined);
				}
			}
		});
	}
}

test("qiuqiu keeps underscore routes and its distinct POST locale contract", async t => {
	const { Got, requests } = await setup(t, 2, "it-it");
	for (const endpoint of ["finish-task", "receive-point", "exchange"]) {
		const request = buildMimoRequest(2, endpoint, { method: "POST", data: { game_id: 2, version_id: 99, lang: "it-it" }, cookie });
		await Got(request.profile, request.options);
		assert.equal(requests.at(-1).url.pathname.endsWith(endpoint.replace(/-/g, "_")), true);
		assert.equal(requests.at(-1).url.search, "?lang=it-it");
		assert.deepEqual(JSON.parse(requests.at(-1).body), { game_id: 2, version_id: 99 });
	}
});

test("latent qiuqiu lottery preserves legacy defaults without registering a profile", async t => {
	const { Got, requests } = await setup(t, 2, "it-it");
	for (const endpoint of ["lottery-info", "lottery"]) {
		const method = endpoint === "lottery" ? "POST" : "GET";
		const payload = { game_id: 2, version_id: 99, lang: "it-it" };
		const request = buildMimoRequest(2, endpoint, { method, params: payload, data: method === "POST" ? payload : null, cookie });
		await Got(request.profile, request.options);
		const actual = requests.at(-1);
		assert.equal(actual.headers["x-rpc-app_version"], "1.5.0");
		assert.equal(actual.headers["x-rpc-client_type"], 5);
		assert.equal(actual.headers["x-rpc-language"], "it-it");
		assert.equal(actual.headers.origin, undefined);
		assert.equal(actual.headers.referer, "https://act.hoyolab.com");
		assert.equal(actual.url.search, method === "POST" ? "" : "?game_id=2&version_id=99&lang=it-it");
	}
});

test("rate-limit retries retain backoff and stop after ten attempts", async t => {
	const { mimo, replies, requests, delays } = await setup(t);
	t.mock.method(Math, "random", () => 0);
	replies.push(
		...Array.from({ length: 9 }, () => ({ statusCode: 429, body: { retcode: -500004 } })),
		{ statusCode: 429, body: { retcode: -500004, message: "Final rate-limit response" } }
	);
	assert.deepEqual(await mimo.finishTask(account, 1, 99), { success: false, message: "Final rate-limit response" });
	assert.equal(requests.length, 10);
	assert.deepEqual(delays, new Array(9).fill(500));
});

test("Mimo failure logs contain only the operation and numeric response metadata", async t => {
	const { mimo, replies, logs } = await setup(t);
	const response = { statusCode: 403,
		body: { retcode: -100, message: "ltoken_v2=synthetic-secret", data: { uid: "synthetic-role" } } };
	const taskId = "synthetic-task";
	const awardId = "synthetic-award";
	for (const [run, message] of [
		[() => mimo.getGameInfo(account), "Failed to fetch Mimo game info"],
		[() => mimo.getTasks(account, 99), "Failed to fetch Mimo tasks"],
		[() => mimo.finishTask(account, taskId, 99), "Failed to finish Mimo task"],
		[() => mimo.claimTaskReward(account, taskId, 99), "Failed to claim Mimo task reward"],
		[() => mimo.getShopItems(account, 99), "Failed to fetch Mimo shop items"],
		[() => mimo.exchangeItem(account, awardId, 99), "Failed to exchange Mimo item"],
		[() => mimo.drawLottery(account, 99), "Failed to draw lottery"]
	]) {
		replies.push(response);
		assert.deepEqual(await run(), { success: false, message: response.body.message });
		assert.deepEqual(logs.splice(0), [["Synthetic Game:Mimo", { message, args: { httpStatus: 403, retcode: -100 } }]]);
	}
});

test("Mimo cron keeps the server message in the critical notification only", async () => {
	const logs = [];
	const notifications = [];
	const message = "Synthetic cookie failure";
	const cronAccount = { uid: "synthetic-role", game: { name: "Honkai: Star Rail" } };
	const cronPath = require.resolve("../crons/mimo/index.js");
	const requireCron = createRequire(cronPath);
	const context = {
		module: { exports: {} },
		require: name => name === "../../config.js" ? {} : requireCron(name),
		app: {
			Logger: { warn: (tag, details) => logs.push([tag, { ...details }]) },
			HoyoLab: {
				getActiveAccounts: () => [cronAccount],
				get: () => ({ mimo: async () => ({ success: false, message }) }),
				getRegion: () => "EU"
			},
			Platform: {
				getForAccount: () => [{ name: "telegram", send: async text => notifications.push(text) }],
				getEmbedPlatforms: () => []
			},
			Utils: { escapeCharacters: text => text }
		}
	};
	runInNewContext(readFileSync(cronPath, "utf8"), context);
	await context.module.exports.code({ gameName: "starrail" });
	assert.deepEqual(logs, [["Cron:Mimo", { message: "Mimo automation failed", game: "starrail" }]]);
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0].includes(message));
});

test("a transport rejection after a rate limit propagates without another retry", async t => {
	const { mimo, delays } = await setup(t);
	const failure = new Error("Synthetic transport failure");
	const send = t.mock.method(app, "Got", async () => ({ statusCode: 429 }));
	send.mock.mockImplementationOnce(async () => {
		throw failure;
	}, 1);
	t.mock.method(Math, "random", () => 0);

	await assert.rejects(() => mimo.finishTask(account, 1, 99), error => error === failure);
	assert.equal(send.mock.callCount(), 2);
	assert.deepEqual(delays, [500]);
});

const emptyShop = { success: true, data: []};
const flow = (mimo, points = 25) => {
	mimo.getGameInfo = async () => ({ success: true, data: { versionId: 999, points } });
	mimo.getTasks = async () => ({ success: true, data: []});
	mimo.getShopItems = async () => emptyShop;
};

test("run keeps task whitelist, claims completed tasks and leaves lottery disabled by default", async t => {
	const { mimo, requests, delays } = await setup(t);
	flow(mimo);
	mimo.getTasks = async () => ({ success: true,
		data: [
			...[1, 2, 4, 10, 101, 102].map(taskType => ({ id: taskType, taskType, status: 2, name: `Task ${taskType}`, point: 5 })),
			{ id: 200, taskType: 101, status: 1, name: "Completed timed task", point: 5 }
		]});
	const finished = [];
	const claimed = [];
	mimo.finishTask = async (data, id) => {
		finished.push(id);
		return { success: true };
	};
	mimo.claimTaskReward = async (data, id) => {
		claimed.push(id);
		return { success: true };
	};
	mimo.getLotteryInfo = async () => {
		throw new Error("Lottery must remain opt-in");
	};
	const result = await mimo.run(account);
	assert.equal(result.success, true);
	assert.deepEqual(finished, [1, 2]);
	assert.deepEqual(claimed, [1, 2, 200]);
	assert.deepEqual(delays, new Array(5).fill(1000));
	assert.equal(requests.length, 0);
});

for (const [points, reservePoints, expectedDraws] of [[19, 0, 0], [25, 10, 0], [25, 0, 1]]) {
	test(`lottery respects balance ${points}, reserve ${reservePoints} and point prizes`, async t => {
		const { mimo } = await setup(t);
		flow(mimo, points);
		mimo.getLotteryInfo = async () => ({ success: true, data: { cost: 20, currentCount: 0, limitCount: 1 } });
		let draws = 0;
		mimo.drawLottery = async () => {
			draws++;
			return { success: true, data: { name: "Points x5" } };
		};
		const result = await mimo.run({ ...account, mimo: { lottery: true, reservePoints } });
		assert.equal(draws, expectedDraws);
		assert.equal(result.data.lotteryDraws.length, expectedDraws);
	});
}

for (const redeem of [false, true]) {
	test(`exchange retains code output and redemption preference ${redeem}`, async t => {
		const { mimo, redeemed } = await setup(t);
		flow(mimo);
		mimo.getShopItems = async () => ({ success: true, data: [{ id: 7, name: "Stellar Jade", cost: 25, status: 1 }]});
		mimo.exchangeItem = async () => ({ success: true, data: { code: "synthetic-code" } });
		const result = await mimo.run({ ...account, mimo: { redeem } });
		assert.equal(result.data.itemsExchanged.length, 1);
		assert.deepEqual(redeemed, redeem ? ["synthetic-code"] : []);
		assert.deepEqual(result.data.codesObtained, redeem ? [] : ["synthetic-code"]);
	});
}

test("failed draw stops lottery and failed exchange does not emit a code", async t => {
	const { mimo, redeemed } = await setup(t);
	flow(mimo, 100);
	mimo.getShopItems = async () => ({ success: true, data: [{ id: 7, name: "Stellar Jade", cost: 25, status: 1 }]});
	mimo.exchangeItem = async () => ({ success: false });
	mimo.getLotteryInfo = async () => ({ success: true, data: { cost: 20, currentCount: 0, limitCount: 5 } });
	let draws = 0;
	mimo.drawLottery = async () => {
		draws++;
		return { success: false };
	};
	const result = await mimo.run({ ...account, mimo: { lottery: true } });
	assert.equal(draws, 1);
	assert.deepEqual(redeemed, []);
	assert.deepEqual(result.data.itemsExchanged, []);
	assert.deepEqual(result.data.lotteryDraws, []);
});

test("Mimo exposes an earned code if credentials cannot be renewed before redemption", async t => {
	const { mimo, redeemed } = await setup(t);
	flow(mimo);
	mimo.getShopItems = async () => ({ success: true, data: [{ id: 7, name: "Stellar Jade", cost: 25, status: 1 }]});
	mimo.exchangeItem = async () => ({ success: true, data: { code: "synthetic-code" } });
	app.HoyoLab.hasRefreshCookie = () => true;
	let renewals = 0;
	app.HoyoLab.refreshStoredCookies = async () => {
		renewals++;
		return false;
	};
	const entry = { ...account, platform: "starrail", redemptionDeviceUuid: "synthetic-device", redeemCode: false, redeemCodeConfigured: true };
	const result = await mimo.run(entry);
	assert.equal(renewals, 1);
	assert.deepEqual(redeemed, []);
	assert.deepEqual(result.data.codesObtained, ["synthetic-code"]);
});

test("upstream shop policy reserves unavailable guaranteed rewards and saves its plan", async t => {
	const { mimo } = await setup(t);
	flow(mimo, 25);
	mimo.getShopItems = async () => ({ success: true, data: [{ id: 7, name: "Stellar Jade", cost: 25, status: 2, stock: 0 }]});
	mimo.getShopPurchases = async () => ({ success: true, data: []});
	mimo.getLotteryInfo = async () => ({ success: true, data: { cost: 20, currentCount: 0, limitCount: 1 } });
	mimo.drawLottery = async () => {
		throw new Error("Guaranteed reward points must be reserved");
	};
	const writes = [];
	app.Cache.set = async entry => writes.push(entry);
	const result = await mimo.run({ ...account, mimo: { lottery: true, shopPolicy: [{ category: "premiumCurrency", mode: "always" }]} });
	assert.equal(result.success, true);
	assert.equal(result.data.lotteryDraws.length, 0);
	assert.ok(writes.length > 0);
});

const shopPlanKey = "starrail:mimo:shop-policy:6:role";
const shopPlanTime = 1_800_000_000_000;
const shopPlanMeta = {
	versionId: 999,
	durationStart: shopPlanTime - 60_000,
	durationEnd: shopPlanTime + 60_000
};
const policyAccount = {
	...account,
	mimo: {
		lottery: true,
		reservePoints: 45,
		shopPolicy: [{ category: "gameMaterials", mode: "conditional" }]
	}
};

const shopGameInfo = points => ({
	success: true,
	data: { versionId: shopPlanMeta.versionId, startTime: shopPlanMeta.durationStart, endTime: shopPlanMeta.durationEnd, points }
});

const cachedJade = {
	id: 7,
	name: "Stellar Jade",
	policyName: "Stellar Jade",
	cost: 40,
	status: 2,
	nextRefreshAt: shopPlanTime + 30_000,
	exhausted: false,
	updatedAt: shopPlanTime - 1000
};
const cachedMaterial = {
	...cachedJade, id: 8, name: "Material", policyName: "Material", cost: 20
};
const shopPlanFixture = {
	...shopPlanMeta,
	formatVersion: 2,
	signature: "7:40:stellar jade|8:20:material",
	thresholdAlways: 0,
	thresholdConditional: 0,
	items: { 7: cachedJade, 8: cachedMaterial },
	updatedAt: shopPlanTime - 1000
};

for (const [label, snapshot, points, expectedInfoCalls, expectedDraws] of [
	["restock before season end", shopPlanFixture, 79, 1, 0],
	["exact safe surplus", shopPlanFixture, 80, 2, 1],
	["restock at season end and static floor", {
		...shopPlanFixture, items: { ...shopPlanFixture.items, 7: { ...cachedJade, nextRefreshAt: shopPlanMeta.durationEnd } }
	}, 65, 2, 1],
	["sold-out reward with expired restock", {
		...shopPlanFixture, items: { ...shopPlanFixture.items, 7: { ...cachedJade, status: 4, nextRefreshAt: shopPlanTime - 1000 } }
	}, 65, 2, 1],
	["missing snapshot", undefined, 100, 0, 0],
	["legacy format", { ...shopPlanFixture, formatVersion: 1 }, 100, 0, 0],
	["invalid items", { ...shopPlanFixture, items: "invalid" }, 100, 0, 0],
	["different version", { ...shopPlanFixture, versionId: 998 }, 100, 0, 0],
	["different season start", { ...shopPlanFixture, durationStart: null }, 100, 0, 0],
	["different season end", { ...shopPlanFixture, durationEnd: null }, 100, 0, 0]
]) {
	test(`Mimo restores shop reserves when the shop is unavailable: ${label}`, async t => {
		const { mimo, requests } = await setup(t);
		t.mock.method(Date, "now", () => shopPlanTime);
		flow(mimo);
		mimo.getGameInfo = async () => shopGameInfo(points);
		mimo.getShopItems = async () => ({ success: false });
		const getCache = t.mock.method(app.Cache, "get", async () => structuredClone(snapshot));
		const setCache = t.mock.method(app.Cache, "set");
		const lotteryInfo = t.mock.method(mimo, "getLotteryInfo", async () => ({
			success: true, data: { cost: 20, currentCount: 0, limitCount: 1 }
		}));
		const draw = t.mock.method(mimo, "drawLottery", async () => ({ success: true, data: { name: "Prize" } }));

		const result = await mimo.run(policyAccount);
		assert.equal(result.success, true);
		assert.equal(lotteryInfo.mock.callCount(), expectedInfoCalls);
		assert.equal(draw.mock.callCount(), expectedDraws);
		assert.equal(result.data.lotteryDraws.length, expectedDraws);
		assert.deepEqual(getCache.mock.calls.map(call => call.arguments), [[shopPlanKey]]);
		assert.equal(setCache.mock.callCount(), 0);
		assert.equal(requests.length, 0);
	});
}

test("Mimo keeps inventory identity across reordering and rebuilds reserves after a price change and purchase", async t => {
	const { mimo, logs, requests } = await setup(t);
	t.mock.method(Date, "now", () => shopPlanTime);
	flow(mimo);
	let points = 55;
	mimo.getGameInfo = async () => shopGameInfo(points);
	const entry = { ...policyAccount, mimo: { ...policyAccount.mimo, reservePoints: 15 } };
	let jade = { id: 7, name: "Stellar Jade", cost: 40, status: 4, nextRefreshTime: 30 };
	const material = { id: 8, name: "Material", cost: 20, status: 1 };
	mimo.getShopItems = async () => ({ success: true, data: [material, jade]});
	mimo.getShopPurchases = async () => ({ success: false });
	await app.Cache.set({
		key: shopPlanKey,
		value: { ...shopPlanFixture, items: { ...shopPlanFixture.items, 7: { ...cachedJade, exhausted: true } } }
	});
	const setCache = t.mock.method(app.Cache, "set");
	const exchange = t.mock.method(mimo, "exchangeItem", async () => ({ success: true, data: {} }));
	mimo.getLotteryInfo = async () => ({ success: true, data: { cost: 20, currentCount: 0, limitCount: 1 } });
	const draw = t.mock.method(mimo, "drawLottery", async () => ({ success: true, data: { name: "Prize" } }));

	const first = await mimo.run(entry);
	assert.equal(first.success, true);
	assert.deepEqual(first.data.itemsExchanged.map(item => item.name), ["Material"]);
	assert.equal(draw.mock.callCount(), 1);
	assert.ok(logs.some(([, message]) => message.includes("Inventory unchanged")));
	const [beforePurchase, afterPurchase] = setCache.mock.calls.map(call => call.arguments[0].value);
	assert.deepEqual(beforePurchase, {
		...shopPlanFixture,
		thresholdAlways: 0,
		thresholdConditional: 20,
		items: {
			7: { ...cachedJade, status: 4, exhausted: true, updatedAt: shopPlanTime },
			8: { ...cachedMaterial, status: 1, nextRefreshAt: null, updatedAt: shopPlanTime }
		},
		updatedAt: shopPlanTime
	});
	assert.deepEqual(afterPurchase, {
		...beforePurchase,
		thresholdConditional: 15,
		items: { ...beforePurchase.items, 8: { ...beforePurchase.items[8], status: 3, exhausted: true } }
	});

	jade = { ...jade, cost: 50 };
	points = 65;
	const second = await mimo.run(entry);
	assert.equal(second.success, true);
	assert.deepEqual(second.data.itemsExchanged, []);
	assert.equal(draw.mock.callCount(), 1);
	assert.ok(logs.some(([, message]) => message.includes("New inventory detected")));
	assert.deepEqual(exchange.mock.calls.map(call => call.arguments.slice(1)), [[8, 999]]);
	const rebuilt = setCache.mock.calls[2].arguments[0].value;
	assert.equal(rebuilt.signature, "7:50:stellar jade|8:20:material");
	assert.equal(rebuilt.items[7].exhausted, false);
	assert.equal(rebuilt.thresholdAlways, 50);
	assert.equal(rebuilt.thresholdConditional, 70);
	assert.deepEqual(setCache.mock.calls.map(call => call.arguments[0].key), new Array(3).fill(shopPlanKey));
	assert.equal(requests.length, 0);
});

test("overlapping scheduled, restock and manual Mimo runs share the account guard", async (t) => {
	const { mimo } = await setup(t);
	flow(mimo);
	let release;
	const blocked = new Promise(resolve => {
		release = resolve;
	});
	let starts = 0;
	mimo.getGameInfo = async () => {
		starts++;
		await blocked;
		return { success: true, data: { versionId: 999, points: 25 } };
	};
	const scheduled = mimo.run(account);
	try {
		for (let i = 0; i < 2; i++) {
			assert.equal((await mimo.run({ ...account })).alreadyRunning, true);
		}
		assert.equal(starts, 1);
	}
	finally {
		release();
	}
	assert.equal((await scheduled).success, true);
	assert.equal((await mimo.run(account)).success, true);
	assert.equal(starts, 4);
});
