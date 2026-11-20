const { t } = require("../../localization/index.js");

const {
	REDEMPTION_GAME_BIZ,
	FINAL_REDEMPTION_ERRORS,
	getPendingCodes,
	waitForQueue,
	getRedemptionAccount,
	canRestoreRedemption,
	redeemWithRefresh
} = require("../../hoyolab-modules/redemption-request.js");

const GAME_CONFIG = [
	{
		key: "genshin",
		modulePath: "./genshin",
		cacheKey: "genshin-code",
		platform: "genshin",
		redeemable: true
	},
	{
		key: "starrail",
		modulePath: "./starrail",
		cacheKey: "starrail-code",
		platform: "starrail",
		redeemable: true
	},
	{
		key: "zenless",
		modulePath: "./zenless",
		cacheKey: "zenless-code",
		platform: "nap",
		redeemable: true
	},
	{
		key: "honkai",
		modulePath: "./honkai",
		cacheKey: "honkai-code",
		platform: "honkai",
		redeemable: false,
		manualReason: t("Redeem this code via the in-game exchange center.")
	},
	{
		key: "tot",
		modulePath: "./tot",
		cacheKey: "tot-code",
		platform: "tot",
		redeemable: true,
		manualReason: t("Redeem this code from the in-game Exchange menu.")
	}
];

const toUpperCase = (value) => String(value).toUpperCase();
const formatCodeValue = (code) => String(code?.code ?? "").toUpperCase();

const getCachedCodes = async (cacheKey) => {
	const cachedCodes = await app.Cache.get(cacheKey);
	return Array.isArray(cachedCodes) ? cachedCodes.map(toUpperCase) : [];
};

const appendCodesToCache = async (cacheKey, codes) => {
	if (!Array.isArray(codes) || codes.length === 0) {
		return;
	}

	const existingCodes = await getCachedCodes(cacheKey);
	const codeSet = new Set(existingCodes);

	let hasUpdates = false;
	for (const code of codes) {
		const normalized = formatCodeValue(code);
		if (!normalized) {
			continue;
		}

		if (codeSet.has(normalized)) {
			continue;
		}

		codeSet.add(normalized);
		hasUpdates = true;
	}

	if (!hasUpdates) {
		return;
	}

	await app.Cache.set({
		key: cacheKey,
		value: Array.from(codeSet)
	});
};

const fetchCodes = async () => {
	const settled = await Promise.allSettled(
		GAME_CONFIG.map(async (game) => {
			const module = require(game.modulePath);
			return await module.fetchData();
		})
	);

	return settled.reduce((acc, result, index) => {
		const game = GAME_CONFIG[index];

		if (result.status === "fulfilled" && Array.isArray(result.value)) {
			acc[game.key] = result.value;
		}
		else {
			acc[game.key] = [];
		}

		return acc;
	}, {});
};

const checkAndRedeem = async (codes) => {
	const newCodes = await checkCachedCodes(codes);

	const success = [];
	const failed = [];
	const manual = [];

	for (const game of GAME_CONFIG) {
		const pendingCodes = newCodes[game.key] ?? [];
		const accounts = app.HoyoLab.getActiveAccounts({
			whitelist: game.platform
		});

		if (game.redeemable === false || game.key === "tot") {
			const manualEligibleAccounts = accounts.filter(acc => acc.redeemCode !== false && (game.key !== "tot" || acc.redeemCode === undefined));
			const manualCacheKey = `${game.cacheKey}:manual`;
			const notifiedCodes = new Set(await getCachedCodes(manualCacheKey));
			if (manualEligibleAccounts.length > 0) {
				const sampleAccount = manualEligibleAccounts[0];
				const platform = app.HoyoLab.get(sampleAccount.platform ?? game.platform);
				const platformAssets = platform?.config?.assets ?? {};
				const accountAssets = sampleAccount.assets ?? {};

				for (const code of pendingCodes) {
					if (game.key === "tot" && notifiedCodes.has(formatCodeValue(code))) {
						continue;
					}
					manual.push({
						gameKey: game.key,
						gameName: sampleAccount.game?.name ?? platformAssets.game ?? game.key.toUpperCase(),
						platform: game.platform,
						assets: {
							color: accountAssets.color ?? platform?.color ?? platformAssets.color ?? 0x5865F2,
							author: accountAssets.author ?? platformAssets.author ?? "HoYoUtils",
							logo: accountAssets.logo ?? platform?.logo ?? platformAssets.logo ?? null
						},
						reason: game.manualReason,
						code
					});
				}
			}

			if (manualEligibleAccounts.length > 0 && game.key === "tot") {
				await appendCodesToCache(manualCacheKey, pendingCodes);
			}
			if (game.redeemable === false || !accounts.some(acc => acc.redeemCode === true || canRestoreRedemption(acc))) {
				await appendCodesToCache(game.cacheKey, pendingCodes);
				continue;
			}
		}

		const { redeemCodes } = require(game.modulePath);
		const gameBiz = REDEMPTION_GAME_BIZ[game.platform];
		const publicCodes = new Map(pendingCodes.map(code => [formatCodeValue(code), code]));
		const completedByAccount = [];

		for (const account of accounts) {
			if (account.redemptionRoleAvailable === false) {
				continue;
			}
			const disabled = game.key === "tot" ? account.redeemCode !== true : account.redeemCode === false;
			if (disabled && !canRestoreRedemption(account)) {
				continue;
			}

			const savedCodes = new Set(await getPendingCodes(gameBiz, account));
			const accountCodes = new Map(publicCodes);
			for (const code of savedCodes) {
				if (!accountCodes.has(code)) {
					accountCodes.set(code, { code, rewards: []});
				}
			}
			if (accountCodes.size === 0) {
				continue;
			}

			const identity = getRedemptionAccount(account);
			const accountCacheKey = `${game.cacheKey}:${identity.region}:${identity.uid}`;
			const completedCodes = new Set(await getCachedCodes(accountCacheKey));
			completedByAccount.push(completedCodes);

			for (const [normalized, code] of accountCodes) {
				if (completedCodes.has(normalized) && !savedCodes.has(normalized)) {
					continue;
				}

				if (savedCodes.has(normalized) && !publicCodes.has(normalized)) {
					await waitForQueue(gameBiz, account);
					const stillPending = await getPendingCodes(gameBiz, account);
					if (!stillPending.includes(normalized)) {
						continue;
					}
				}

				let result;
				try {
					result = await redeemWithRefresh(account, code.code, () => redeemCodes(account, code), { automatic: true, persist: false });
				}
				catch {
					result = { success: false, reason: "Redemption request failed; will retry on the next run." };
				}

				if (result.loginExpired) {
					failed.push({ account, code, loginExpired: true });
					break;
				}

				if (result.success || FINAL_REDEMPTION_ERRORS.has(result.retcode)) {
					completedCodes.add(normalized);
					await app.Cache.set({
						key: accountCacheKey,
						value: [...completedCodes]
					});
				}

				if (result.success) {
					success.push({ account, code });
				}
				else {
					failed.push({
						account,
						code,
						notificationKey: `${accountCacheKey}:failed:${normalized}`,
						reason: result.reason,
						retcode: result.retcode
					});
				}
			}
		}

		if (completedByAccount.length > 0) {
			const completedCodes = pendingCodes.filter(code => completedByAccount.every(completed => completed.has(formatCodeValue(code))));
			await appendCodesToCache(game.cacheKey, completedCodes);
		}
	}

	return {
		success,
		failed,
		manual
	};
};

const checkCachedCodes = async (codes) => {
	const newCodes = {};

	for (const game of GAME_CONFIG) {
		const incomingCodes = Array.isArray(codes[game.key]) ? codes[game.key] : [];

		if (incomingCodes.length === 0) {
			newCodes[game.key] = [];
			continue;
		}

		const cachedCodes = await getCachedCodes(game.cacheKey);
		if (cachedCodes.length === 0) {
			const cachedValues = incomingCodes
				.map(formatCodeValue)
				.filter(Boolean);

			await app.Cache.set({
				key: game.cacheKey,
				value: cachedValues
			});
			newCodes[game.key] = [];
			continue;
		}

		newCodes[game.key] = incomingCodes.filter((code) => {
			const normalized = formatCodeValue(code);
			return normalized && !cachedCodes.includes(normalized);
		});
	}

	return newCodes;
};

module.exports = {
	fetchCodes,
	checkAndRedeem
};
