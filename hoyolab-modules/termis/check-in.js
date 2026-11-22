const { t } = require("../../localization/index.js");
const { readSignResponse, readSignInfoResponse, readAwardsResponse } = require("../check-in-response.js");
const { requestCheckIn, getCheckInAward, createCheckInResultBuilder } = require("../check-in.js");
const descriptor = require("./check-in-descriptor.js");

module.exports = async function runThemisCheckIn (game) {
	const accounts = game.accounts;
	if (accounts.length === 0) {
		app.Logger.warn(t("No active accounts found for Tears of Themis"));
		return;
	}

	const results = [];
	const buildResult = createCheckInResultBuilder(game);
	const context = `${game.fullName}:CheckIn`;
	for (const account of accounts) {
		const info = readSignInfoResponse(await requestCheckIn(game, descriptor, "info", account.cookie), game.fullName, { validateState: false });
		if (!info.success) {
			results.push(buildResult(account, { failed: true, result: info.reason }, "Global"));
			continue;
		}

		const awards = readAwardsResponse(await requestCheckIn(game, descriptor, "home", account.cookie), game.fullName);
		if (!awards.success) {
			results.push(buildResult(account, { failed: true, result: awards.reason }, "Global"));
			continue;
		}

		const state = info.data;
		const award = getCheckInAward(awards.data, state);
		if (state.issign) {
			app.Logger.info(context, t `Already signed in today`);
			results.push(buildResult(account, { total: state.total, result: game.config.signedMessage, award }, "Global"));
			continue;
		}

		const sign = readSignResponse(await requestCheckIn(game, descriptor, "sign", account.cookie), game.name);
		if (!sign.success) {
			results.push(buildResult(account, { failed: true, result: sign.reason }, "Global"));
			continue;
		}

		app.Logger.info(context, t `Today's Reward: ${award.name} x${award.count}`);
		results.push(buildResult(account, { total: state.total + 1, result: game.config.successMessage, award }, "Global"));
	}

	return results;
};
