const crypto = require("node:crypto");
const { t } = require("../localization/index.js");
const { notifyRedemption } = require("./redemption-notification.js");

const queues = new Map();
const pendingWrites = new Map();
const nextRequestAt = new Map();
const TEMPORARY_REDEMPTION_ERRORS = new Set([-1048, -1071, -2016]);
const FINAL_REDEMPTION_ERRORS = new Set([-2001, -2003, -2006, -2017]);
const REQUEST_INTERVAL = 6000;
const LOGIN_RETRY_DELAY = 30 * 60 * 1000;
const REDEMPTION_GAME_BIZ = {
	genshin: "hk4e_global",
	starrail: "hkrpg_global",
	nap: "nap_global",
	tot: "nxx_global"
};

const getRedemptionAccount = account => account.redemptionQueueAccount ?? account;

const isRedemptionLoginExpired = ({ retcode, reason, message, loginExpired }) => retcode !== 0
	&& !FINAL_REDEMPTION_ERRORS.has(retcode)
	&& (loginExpired === true || retcode === -100 || retcode === -10001 || /\blog\s*in\b/i.test(String(reason ?? message ?? "")));

const isTemporaryFailure = (res) => res.statusCode !== 200
	|| typeof res.body?.retcode !== "number"
	|| TEMPORARY_REDEMPTION_ERRORS.has(res.body.retcode)
	|| isRedemptionLoginExpired(res.body);

const accountKey = (gameBiz, account) => {
	const identity = getRedemptionAccount(account);
	return `${gameBiz}:${identity.region}:${identity.uid}`;
};
const pendingKey = (key) => `redemption:pending:${key}`;

const getPendingCodes = async (gameBiz, account) => {
	const codes = await app.Cache.get(pendingKey(accountKey(gameBiz, account)));
	return Array.isArray(codes) ? codes : [];
};

const updatePending = async (key, code, add) => {
	const previous = pendingWrites.get(key) ?? Promise.resolve();
	const write = previous.catch(() => {}).then(async () => {
		const stored = await app.Cache.get(pendingKey(key));
		const codes = Array.isArray(stored) ? stored : [];
		const updated = add ? [...new Set([...codes, code])] : codes.filter(value => value !== code);
		if (updated.length !== codes.length) {
			await app.Cache.set({ key: pendingKey(key), value: updated });
		}
	});
	pendingWrites.set(key, write);
	try {
		await write;
	}
	finally {
		if (pendingWrites.get(key) === write) {
			pendingWrites.delete(key);
		}
	}
};

const savePendingCode = (gameBiz, account, code) => updatePending(accountKey(gameBiz, account), String(code).toUpperCase(), true);

const canRestoreRedemption = account => account.redeemCode === false
	&& account.redeemCodeConfigured === true
	&& (!["starrail", "nap"].includes(account.platform) || Boolean(account.redemptionDeviceUuid))
	&& app.HoyoLab.hasRefreshCookie?.(account.cookie);

const getRedemptionCookieHash = account => {
	const cookie = app.HoyoLab.parseCookie(account.cookie, {
		whitelist: ["cookie_token_v2", "account_mid_v2", "account_id_v2", "cookie_token", "account_id"]
	});
	const normalized = cookie.split(";").map(pair => pair.trim()).sort()
		.join(";");
	return crypto.createHash("sha256").update(normalized).digest("hex");
};

const loginKey = account => {
	const { region, uid } = getRedemptionAccount(account);
	const game = account.platform === "nap" ? "zenless" : account.platform;
	return `${game}-code:${region}:${uid}:expired-login`;
};

const notifyExpiredLogin = (account, notificationKey) => notifyRedemption("failed", { account, notificationKey, loginExpired: true });

const redeemWithRefresh = async (account, code, redeem, { automatic = false, persist = true } = {}) => {
	const key = loginKey(account);
	const gameBiz = REDEMPTION_GAME_BIZ[account.platform];
	const cookie = account.cookie;
	if (automatic) {
		const pause = await app.Cache.get(key);
		// Legacy bare hashes have no retry deadline and are reconsidered on demand.
		if (pause?.retryAt > Date.now() && pause.cookieHash === getRedemptionCookieHash(account)) {
			if (persist && gameBiz) {
				await savePendingCode(gameBiz, account, code);
			}
			await notifyExpiredLogin(account, `${key}:${pause.cookieHash}`);
			return { success: false, loginExpired: true, message: t("Code Redemption Paused - HoYoLAB Login Expired") };
		}
		if (pause) {
			await app.Cache.delete(key);
		}
	}

	let result;
	if (canRestoreRedemption(account)) {
		if (await app.HoyoLab.refreshStoredCookies(cookie)) {
			result = await redeem();
		}
		else {
			if (persist && gameBiz) {
				await savePendingCode(gameBiz, account, code);
			}
			result = { success: false, loginExpired: true, message: t("Could not renew the redemption cookie.") };
		}
	}
	else {
		result = await redeem();
		if (!result.success && isRedemptionLoginExpired(result)
			&& (account.cookie !== cookie || (cookie && await app.HoyoLab.refreshStoredCookies(cookie)))) {
			result = await redeem();
		}
	}
	if (result.success || !isRedemptionLoginExpired(result)) {
		return result;
	}
	const cookieHash = getRedemptionCookieHash(account);
	if (automatic) {
		await app.Cache.set({ key, value: { cookieHash, retryAt: Date.now() + LOGIN_RETRY_DELAY } });
	}
	await notifyExpiredLogin(account, `${key}:${cookieHash}`);
	return { ...result, loginExpired: true };
};

// Public codes, event rewards and manual redemptions share the same account cooldown.
const redemptionRequest = async (options, { persist = false, profile = "HoYoLabDesktopWeb", queueAccount } = {}) => {
	const params = options.json ?? options.searchParams;
	const payloadKey = options.json ? "json" : "searchParams";
	const key = accountKey(params.game_biz, queueAccount ?? params);
	const code = String(params.cdkey).toUpperCase();
	const previous = queues.get(key) ?? Promise.resolve();
	const saved = persist ? updatePending(key, code, true) : Promise.resolve();
	const request = Promise.allSettled([previous, saved]).then(async ([, savedResult]) => {
		if (savedResult.status === "rejected") {
			throw savedResult.reason;
		}

		let res;
		for (let attempt = 0; attempt < 3; attempt++) {
			const delay = (nextRequestAt.get(key) ?? 0) - Date.now();
			if (delay > 0) {
				await app.Utils.waitWithJitter(delay);
			}
			try {
				res = await app.Got(profile, {
					...options,
					[payloadKey]: { ...params, ...(params.t !== undefined && { t: Date.now() }) }
				});
			}
			finally {
				nextRequestAt.set(key, Date.now() + REQUEST_INTERVAL);
			}

			if (res.statusCode !== 200 || res.body?.retcode !== -2016) {
				break;
			}
			const seconds = Number(res.body.message?.match(/(\d+(?:\.\d+)?)\s*second/i)?.[1]);
			const cooldown = Number.isFinite(seconds) ? seconds * 1000 + 1000 : REQUEST_INTERVAL;
			nextRequestAt.set(key, Date.now() + Math.max(REQUEST_INTERVAL, cooldown));
		}

		if (!isTemporaryFailure(res)) {
			await updatePending(key, code, false);
		}
		return res;
	});
	queues.set(key, request);
	try {
		return await request;
	}
	finally {
		if (queues.get(key) === request) {
			queues.delete(key);
		}
	}
};

const waitForQueue = async (gameBiz, account) => {
	const key = accountKey(gameBiz, account);
	let previous;
	let current = queues.get(key);
	while (current && current !== previous) {
		await current.catch(() => {});
		previous = current;
		current = queues.get(key);
	}
};

module.exports = redemptionRequest;
module.exports.getPendingCodes = getPendingCodes;
module.exports.waitForQueue = waitForQueue;
module.exports.savePendingCode = savePendingCode;
module.exports.FINAL_REDEMPTION_ERRORS = FINAL_REDEMPTION_ERRORS;
module.exports.REDEMPTION_GAME_BIZ = REDEMPTION_GAME_BIZ;
module.exports.getRedemptionAccount = getRedemptionAccount;
module.exports.getRedemptionCookieHash = getRedemptionCookieHash;
module.exports.isRedemptionLoginExpired = isRedemptionLoginExpired;
module.exports.canRestoreRedemption = canRestoreRedemption;
module.exports.redeemWithRefresh = redeemWithRefresh;
