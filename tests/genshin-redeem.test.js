const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRedemptionHarness } = require("./helpers/http.js");
const Genshin = require("../hoyolab-modules/genshin/index.js");
const { REDEMPTION_URL } = require("../hoyolab-modules/genshin/redemption-request.js");
const HoyoLab = require("../hoyolab-modules/template.js");
const { redeemCodes } = require("../crons/code-redeem/genshin.js");
const { getPendingCodes, getRedemptionCookieHash, redeemWithRefresh } = require("../hoyolab-modules/redemption-request.js");

// Browser request contracts and return/cache regression coverage; no live requests.
const account = {
	uid: "synthetic-role",
	nickname: "Synthetic Traveler",
	region: "os_euro",
	platform: "genshin",
	redeemCode: true,
	cookie: "ltoken_v2=synthetic-token; ltuid_v2=synthetic-id; ltmid_v2=synthetic-mid; cookie_token_v2=synthetic-cookie-token; account_mid_v2=synthetic-account-mid; account_id_v2=synthetic-account-id"
};
const code = { code: "SYNTHETICCODE", rewards: ["Synthetic reward"]};

const setup = async (t, language) => {
	const harness = await createRedemptionHarness(t, { language });
	for (const name of ["info", "warn", "log"]) {
		app.Logger[name] = (...args) => harness.logs.push(args);
	}
	app.Error = class extends Error {
		constructor ({ message }) { super(message); }
	};
	app.HoyoLab = {
		parseCookie: HoyoLab.parseCookie,
		errorMessage: HoyoLab.errorMessage,
		getActiveAccounts: ({ whitelist }) => whitelist === "genshin" ? [account] : [],
		isExpiredLogin: () => false
	};
	const module = {
		redeemCode: (data, value) => Genshin.prototype.redeemCode.call({
			name: "genshin",
			fullName: "Genshin Impact",
			config: { url: { redemption: REDEMPTION_URL } }
		}, data, value)
	};
	return { ...harness, module };
};

for (const caller of ["module", "cron"]) {
	const invoke = ({ module }) => caller === "module"
		? module.redeemCode(account, code.code)
		: redeemCodes(account, code);

	for (const language of [undefined, "it-it"]) {
		test(`${caller} uses the browser redemption contract (${language ?? "default"})`, async (t) => {
			const harness = await setup(t, language);
			harness.replies.push({ body: { retcode: 0 } });
			assert.equal((await invoke(harness)).success, true);
			assert.equal(harness.requests.length, 1);
			const [request] = harness.requests;
			assert.equal(request.url.origin, "https://public-operation-hk4e.hoyoverse.com");
			assert.equal(request.url.pathname, "/common/apicdkey/api/webExchangeCdkey");
			assert.equal(request.method, "GET");
			assert.equal(request.body, undefined);
			assert.deepEqual(Object.fromEntries(request.url.searchParams), {
				uid: account.uid,
				region: account.region,
				lang: language ? "it" : "en",
				cdkey: code.code,
				game_biz: "hk4e_global",
				sLangKey: "en-us"
			});
			assert.equal(request.headers.cookie, account.cookie);
			assert.equal(request.headers.origin, "https://genshin.hoyoverse.com");
			assert.equal(request.headers.referer, "https://genshin.hoyoverse.com/");
			assert.equal(request.headers.accept, "application/json, text/plain, */*");
			assert.match(request.headers["user-agent"], /Mozilla.*Chrome/);
			assert.equal(request.headers.ds, undefined);
			assert.equal(request.headers["x-requested-with"], undefined);
			assert.deepEqual(Object.keys(request.headers).filter(key => key.startsWith("x-rpc-")), []);
		});
	}

	test(`${caller} redemption preserves its success result`, async (t) => {
		const harness = await setup(t);
		harness.replies.push({ body: { retcode: 0, message: "OK", data: { msg: "Codice riscattato" } } });
		assert.deepEqual(await invoke(harness), caller === "module"
			? { success: true, message: "Code redeemed successfully!" }
			: { success: true });
		assert.equal(harness.requests.length, 1);
		assert.ok(!JSON.stringify(harness.logs).includes("synthetic-token"));
	});

	for (const retcode of [-2011, -2001, -2003, -9999]) {
		test(`${caller} redemption preserves failure ${retcode}`, async (t) => {
			const harness = await setup(t);
			const message = "Synthetic API failure";
			harness.replies.push({ body: { retcode, message } });
			assert.deepEqual(await invoke(harness), caller === "module"
				? { success: false, retcode, message }
				: { success: false, reason: [-2001, -2003].includes(retcode) ? "Expired or invalid code" : message, retcode });
			assert.equal(harness.requests.length, 1);
		});
	}

	test(`${caller} redemption preserves HTTP failure behavior`, async (t) => {
		const harness = await setup(t);
		harness.replies.push({ statusCode: 503, body: { message: "Synthetic outage" } });
		if (caller === "module") {
			assert.deepEqual(await invoke(harness), { success: false });
		}
		else {
			await assert.rejects(invoke(harness), /API returned non-200 status code/);
		}
		assert.equal(harness.requests.length, 1);
	});
}

const setupCache = async (t, initial = ["PREVIOUSCODE"]) => {
	const harness = await setup(t);
	const cache = new Map(initial ? [["genshin-code", initial]] : []);
	app.Cache = {
		get: async (key) => structuredClone(cache.get(key)),
		set: async ({ key, value }) => cache.set(key, structuredClone(value)),
		delete: async key => cache.delete(key)
	};
	const { delays } = harness;
	const utilsPath = require.resolve("../crons/code-redeem/utils.js");
	delete require.cache[utilsPath];
	t.after(() => {
		delete require.cache[utilsPath];
	});
	return { ...harness, cache, delays, ...require(utilsPath) };
};

test("a legacy pause is retried for a real code and a failed renewal is backed off", async t => {
	const { checkAndRedeem, cache, replies, requests } = await setupCache(t);
	const key = `genshin-code:${account.region}:${account.uid}:expired-login`;
	cache.set(key, getRedemptionCookieHash(account));
	app.HoyoLab.hasRefreshCookie = () => true;
	let renewals = 0;
	app.HoyoLab.refreshStoredCookies = async () => ++renewals > 1;
	const telegramMessages = [];
	const gotifyMessages = [];
	let gotifyAttempts = 0;
	let discordAttempts = 0;
	app.Platform = {
		getForAccount: selected => {
			assert.equal(selected, account);
			return [
				{ name: "telegram", id: 1, send: async message => telegramMessages.push(message) },
				{ name: "gotify",
					id: 2,
					createUserMention: () => null,
					send: async (message, options) => {
						if (++gotifyAttempts === 1) {
							throw new Error("Synthetic delivery failure");
						}
						gotifyMessages.push({ message, options });
					} },
				{ name: "discord", id: 3, send: async () => discordAttempts++ }
			];
		}
	};

	await checkAndRedeem({});
	assert.equal(requests.length, 0);
	assert.equal(renewals, 0);
	assert.equal(telegramMessages.length, 0);
	assert.equal(gotifyAttempts, 0);

	const loginFailure = { body: { retcode: -100, message: "Sessione scaduta" } };
	replies.push(loginFailure);
	const codes = { genshin: [code]};
	assert.equal((await checkAndRedeem(codes)).failed[0].loginExpired, true);
	assert.equal(cache.get(key).cookieHash, getRedemptionCookieHash(account));
	assert.equal((await checkAndRedeem(codes)).failed[0].loginExpired, true);
	assert.equal(renewals, 1);
	assert.equal(requests.length, 1);
	assert.equal(telegramMessages.length, 1);
	assert.match(telegramMessages[0], /HoYoLAB Login Expired/);
	assert.doesNotMatch(telegramMessages[0], /SYNTHETICCODE|synthetic-cookie-token/);
	assert.equal(gotifyAttempts, 2);
	assert.equal(gotifyMessages[0].options.notificationType, "cookie");

	await app.Utils.waitWithJitter(30 * 60 * 1000);
	replies.push(loginFailure, { body: { retcode: 0 } });
	assert.equal((await checkAndRedeem(codes)).success[0].code, code);
	assert.equal(renewals, 2);
	assert.equal(requests.length, 3);
	assert.equal(cache.has(key), false);
	assert.equal(telegramMessages.length, 1);
	assert.equal(gotifyAttempts, 2);
	assert.equal(discordAttempts, 0);
});

test("concurrent real redemption failures share one alert and terminal code errors do not alert", async t => {
	const { cache } = await setupCache(t);
	const alerts = [];
	app.HoyoLab.refreshStoredCookies = async () => false;
	app.Platform = { getForAccount: () => [{ name: "telegram", id: 1, send: async message => alerts.push(message) }]};
	const reject = async () => ({ success: false, retcode: -100, message: "Sessione scaduta" });
	const options = { automatic: true };
	await Promise.all([redeemWithRefresh(account, code.code, reject, options), redeemWithRefresh(account, code.code, reject)]);
	const key = `genshin-code:${account.region}:${account.uid}:expired-login:${getRedemptionCookieHash(account)}`;
	assert.deepEqual(cache.get(key), [1]);
	assert.equal(alerts.length, 1);
	const renewed = { ...account, cookie: account.cookie.replace("synthetic-cookie-token", "another-cookie-token") };
	await redeemWithRefresh(renewed, code.code, async () => ({ success: false, retcode: -2006, message: "Already redeemed, log in to view rewards" }));
	assert.equal(alerts.length, 1);
	await redeemWithRefresh(renewed, code.code, reject);
	assert.equal(alerts.length, 2);
});

test("credentials are restored only when a real code is ready for an opted-in account", async t => {
	const { checkAndRedeem, replies, requests } = await setupCache(t);
	const entry = { ...account, redeemCode: false, redeemCodeConfigured: true };
	app.HoyoLab.getActiveAccounts = ({ whitelist }) => whitelist === "genshin" ? [entry] : [];
	app.HoyoLab.hasRefreshCookie = () => true;
	let renewals = 0;
	app.HoyoLab.refreshStoredCookies = async () => {
		renewals++;
		entry.redeemCode = true;
		return true;
	};
	await checkAndRedeem({});
	assert.equal(renewals, 0);
	entry.redeemCodeConfigured = false;
	await checkAndRedeem({ genshin: [code]});
	assert.equal(renewals, 0);
	assert.equal(requests.length, 0);
	entry.redeemCodeConfigured = true;
	replies.push({ body: { retcode: 0 } });
	assert.equal((await checkAndRedeem({ genshin: [code]})).success[0].code, code);
	assert.equal(renewals, 1);
	assert.equal(requests.length, 1);
});

test("reward codes survive failed preflight and the pause, then retry without a public feed", async t => {
	const { checkAndRedeem, replies, requests } = await setupCache(t);
	const entry = { ...account, redeemCode: false, redeemCodeConfigured: true };
	app.HoyoLab.getActiveAccounts = ({ whitelist }) => whitelist === "genshin" ? [entry] : [];
	app.HoyoLab.hasRefreshCookie = () => true;
	let renewals = 0;
	app.HoyoLab.refreshStoredCookies = async () => {
		if (++renewals === 1) {
			return false;
		}
		entry.redeemCode = true;
		return true;
	};
	const options = { automatic: true };
	const redeem = () => assert.fail("The gift endpoint should not be called");
	assert.equal((await redeemWithRefresh(entry, "FIRST", redeem, options)).loginExpired, true);
	assert.equal((await redeemWithRefresh(entry, "SECOND", redeem, options)).loginExpired, true);
	assert.equal(renewals, 1);
	assert.equal(requests.length, 0);
	assert.deepEqual(await getPendingCodes("hk4e_global", entry), ["FIRST", "SECOND"]);

	await app.Utils.waitWithJitter(30 * 60 * 1000);
	replies.push({ body: { retcode: 0 } }, { body: { retcode: 0 } });
	const result = await checkAndRedeem({});
	assert.deepEqual(result.success.map(entry => entry.code.code), ["FIRST", "SECOND"]);
	assert.equal(renewals, 2);
	assert.deepEqual(await getPendingCodes("hk4e_global", entry), []);
});

test("cron seeds an empty code cache without redemption", async (t) => {
	const { checkAndRedeem, cache, requests } = await setupCache(t, null);
	assert.deepEqual(await checkAndRedeem({ genshin: [code]}), { success: [], failed: [], manual: []});
	assert.deepEqual(cache.get("genshin-code"), [code.code]);
	assert.equal(requests.length, 0);
});

for (const retcode of [0, -2011]) {
	test(`cron preserves result grouping, delay and deduplication (${retcode})`, async (t) => {
		const { checkAndRedeem, replies, requests, delays, cache } = await setupCache(t);
		replies.push({ body: { retcode, message: "Synthetic result" } });
		const result = await checkAndRedeem({ genshin: [code]});
		const expectedFailed = retcode === 0
			? []
			: [{
				account,
				code,
				notificationKey: `genshin-code:${account.region}:${account.uid}:failed:${code.code}`,
				reason: "Synthetic result",
				retcode
			}];
		assert.deepEqual(result, {
			success: retcode === 0 ? [{ account, code }] : [],
			failed: expectedFailed,
			manual: []
		});
		assert.deepEqual(cache.get("genshin-code"), retcode === 0 ? ["PREVIOUSCODE", code.code] : ["PREVIOUSCODE"]);
		assert.deepEqual(delays, []);
		if (retcode === 0) {
			assert.deepEqual(await checkAndRedeem({ genshin: [{ ...code, code: code.code.toLowerCase() }]}), { success: [], failed: [], manual: []});
			assert.equal(requests.length, 1);
		}
		else {
			replies.push({ body: { retcode: 0, message: "Synthetic retry success" } });
			assert.deepEqual(await checkAndRedeem({ genshin: [{ ...code, code: code.code.toLowerCase() }]}), {
				success: [{ account, code: { ...code, code: code.code.toLowerCase() } }],
				failed: [],
				manual: []
			});
			assert.equal(requests.length, 2);
			assert.deepEqual(delays, [6000]);
		}
	});
}

test("cron HTTP failure does not cache the pending code", async (t) => {
	const { checkAndRedeem, replies, cache, delays } = await setupCache(t);
	replies.push({ statusCode: 503 });
	assert.deepEqual(await checkAndRedeem({ genshin: [code]}), {
		success: [],
		failed: [{
			account,
			code,
			notificationKey: `genshin-code:${account.region}:${account.uid}:failed:${code.code}`,
			reason: "Redemption request failed; will retry on the next run.",
			retcode: undefined
		}],
		manual: []
	});
	assert.deepEqual(cache.get("genshin-code"), ["PREVIOUSCODE"]);
	assert.deepEqual(delays, []);
});
