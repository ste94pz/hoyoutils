const { t } = require("../../localization/index.js");
const { buildCheckInFields, buildCheckInText } = require("../../hoyolab-modules/check-in-notification.js");

const NOTIFICATION_MODES = ["all", "failures", "none"];

const getNotificationMode = () => {
	const mode = app.Config.get("notifications")?.checkIn ?? "all";
	if (!NOTIFICATION_MODES.includes(mode)) {
		app.Logger.warn("Cron:CheckIn", t `Invalid check-in notification mode "${mode}", falling back to "all"`);
		return "all";
	}

	return mode;
};

module.exports = {
	name: "check-in",
	expression: "0 0 0 * * *",
	description: t("Run daily check-in every day at midnight or your specified time"),
	code: (async function checkIn () {
		const accounts = app.HoyoLab.getActiveAccounts();
		if (accounts.length === 0) {
			app.Logger.warn("Cron:CheckIn", t("No active accounts found for HoyoLab"));
			return;
		}

		const messages = [];
		const activeGameAccounts = app.HoyoLab.getActivePlatform();
		for (const name	of activeGameAccounts) {
			const platform = app.HoyoLab.get(name);

			const execution = await platform.checkIn();
			if (execution.length === 0) {
				app.Logger.info("Cron:CheckIn", t("All accounts either signed in or failed to sign in"));
				continue;
			}

			messages.push(...execution);
		}

		if (messages.length === 0) {
			app.Logger.info("Cron:CheckIn", t("No accounts to run check-in for"));
			return;
		}

		const mode = getNotificationMode();
		const notifications = messages.filter(message => mode === "all" || (mode === "failures" && message.failed));

		for (let i = 0; i < notifications.length; i++) {
			const message = notifications[i];
			const account = app.HoyoLab.getAccountById(message.uid);
			const platforms = app.Platform.getForAccount(account);

			const embed = {
				color: message.failed ? 0xFF0000 : message.assets.color,
				title: message.failed ? t `❌ ${message.assets.game} Check-In Failed` : message.assets.game,
				author: {
					name: message.assets.author,
					icon_url: message.assets.logo
				},
				...(!message.failed && { thumbnail: { url: message.award.icon } }),
				fields: buildCheckInFields(message),
				timestamp: new Date(),
				footer: {
					text: t `HoYoUtils Check-In (${i + 1}/${notifications.length}) Executed`,
					icon_url: message.assets.logo
				}
			};

			for (const destination of app.Platform.getEmbedPlatforms(platforms)) {
				await destination.send(embed, {
					author: message.assets.author,
					icon: message.assets.logo,
					notificationType: "checkIn"
				});
			}

			const title = message.failed
				? t `❌ **${message.assets.game}** Check-In Failed`
				: t `🎮 **${message.assets.game}** Daily Check-In`;
			const messageText = buildCheckInText(message, title);
			const escapedMessage = app.Utils.escapeCharacters(messageText);
			for (const telegram of platforms.filter(p => p.name === "telegram")) {
				await telegram.send(escapedMessage);
			}
		}
	})
};
