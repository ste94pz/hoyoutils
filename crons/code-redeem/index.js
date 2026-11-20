const { t } = require("../../localization/index.js");
const { canRestoreRedemption } = require("../../hoyolab-modules/redemption-request.js");
const { notifyRedemption } = require("../../hoyolab-modules/redemption-notification.js");
const { fetchCodes, checkAndRedeem } = require("./utils");

module.exports = {
	name: "code-redeem",
	expression: "* * * * *",
	description: t("Check and redeem codes for supported games from HoyoLab."),
	code: async function codeRedeem () {
		const accountData = app.HoyoLab.getActiveAccounts();

		if (accountData.length === 0) {
			app.Logger.info(t("No active accounts found"));
			return;
		}

		const redeemDisabled = accountData.every(account => account.redeemCode === false && !canRestoreRedemption(account));
		if (redeemDisabled) {
			app.Logger.info("CodeRedeem", t("All accounts have redeem disabled"));

			return;
		}

		const codes = await fetchCodes();
		if (Object.values(codes).every((i) => i.length === 0)) {
			app.Logger.debug("CodeRedeem", {
				message: t("No codes found")
			});
		}

		const { success, failed, manual } = await checkAndRedeem(codes);
		for (const data of success) {
			await notifyRedemption("success", data);
		}
		for (const data of failed.filter(entry => !entry.loginExpired)) {
			await notifyRedemption("failed", data);
		}
		for (const data of manual) {
			await notifyRedemption("manual", data);
		}
	}
};
