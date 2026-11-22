const { t } = require("../localization/index.js");
const { readSignResponse, readSignInfoResponse, readAwardsResponse } = require("./check-in-response.js");

function requestCheckIn (game, descriptor, endpoint, cookie) {
	const { ACT_ID, url } = game.config;
	const options = endpoint === "sign" ? descriptor.signOptions(ACT_ID) : descriptor.readOptions(ACT_ID);
	return app.Got(descriptor.profile, {
		...options,
		url: url[endpoint],
		responseType: "json",
		headers: { ...options.headers, Cookie: cookie }
	});
}

function getCheckInAward (awards, { total, issign }) {
	const award = awards[issign ? total - 1 : total];
	return { name: award.name, count: award.cnt, icon: award.icon };
}

function createCheckInResultBuilder (game) {
	const { logo, color } = game;
	return (account, { failed, result, total, award }, region = app.HoyoLab.getRegion(account.region)) => ({
		...(failed && { failed }),
		uid: account.uid,
		platform: game.name,
		rank: account.level,
		username: account.nickname,
		region,
		...(!failed && { total }),
		result: failed ? result ?? t("Unknown error") : result,
		assets: { ...game.config.assets, logo, color },
		...(!failed && { award })
	});
}

async function runCheckIn (game, descriptor, noAccountsMessage, signContext = game.fullName) {
	const accounts = game.accounts;
	if (accounts.length === 0) {
		app.Logger.warn(t(noAccountsMessage));
		return;
	}

	const results = [];
	const buildResult = createCheckInResultBuilder(game);
	const context = `${game.fullName}:CheckIn`;
	for (const account of accounts) {
		const info = readSignInfoResponse(await requestCheckIn(game, descriptor, "info", account.cookie), game.fullName);
		if (!info.success) {
			results.push(buildResult(account, { failed: true, result: info.reason }));
			continue;
		}

		const awards = readAwardsResponse(await requestCheckIn(game, descriptor, "home", account.cookie), game.fullName);
		if (!awards.success) {
			results.push(buildResult(account, { failed: true, result: awards.reason }));
			continue;
		}

		const state = info.data;
		const award = getCheckInAward(awards.data, state);
		if (state.issign) {
			app.Logger.info(context, t `${account.nickname} already signed in today`);
			results.push(buildResult(account, { total: state.total, result: t(game.config.signedMessage), award }));
			continue;
		}

		const sign = readSignResponse(await requestCheckIn(game, descriptor, "sign", account.cookie), signContext);
		if (!sign.success) {
			results.push(buildResult(account, { failed: true, result: sign.reason }));
			continue;
		}

		const confirmation = readSignInfoResponse(await requestCheckIn(game, descriptor, "info", account.cookie), game.fullName);
		if (!confirmation.success || confirmation.data.issign !== true || confirmation.data.today !== state.today) {
			app.Logger.warn(context, "Check-in could not be confirmed for today");
			continue;
		}

		app.Logger.info(context, t `(${account.uid}) ${account.nickname} Today's Reward: ${award.name} x${award.count}`);
		results.push(buildResult(account, { total: confirmation.data.total, result: t(game.config.successMessage), award }));
	}

	return results;
}

module.exports = { runCheckIn, requestCheckIn, getCheckInAward, createCheckInResultBuilder };
