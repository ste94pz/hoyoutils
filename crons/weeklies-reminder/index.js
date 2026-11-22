const { t } = require("../../localization/index.js");
const readWeeklyProgress = require("../../hoyolab-modules/weekly-progress.js");

const RegionalTaskManager = new app.RegionalTaskManager();

function getObjectives (type, data) {
	const progress = readWeeklyProgress(type, data);
	if (!progress) {
		return null;
	}

	const objectives = [];

	if (type === "genshin") {
		const { resinDiscount } = progress;
		if (!resinDiscount) {
			return null;
		}
		if (resinDiscount.value !== 0) {
			objectives.push({
				...resinDiscount,
				label: "Resin Discount",
				embedKey: "{0}/{1} Available",
				telegramKey: "- **Resin Discount**: {0}/{1} Available"
			});
		}
	}
	if (type === "starrail") {
		const { boss, simulatedUniverse, divergentUniverse, tournUnlocked } = progress;
		if (boss && boss.value !== 0) {
			objectives.push({
				...boss,
				label: "Weekly Boss",
				embedKey: "{0}/{1} Completed",
				telegramKey: "- **Weekly Boss**: {0}/{1} Completed"
			});
		}
		if (simulatedUniverse && simulatedUniverse.value !== simulatedUniverse.total) {
			objectives.push({
				...simulatedUniverse,
				label: "Simulated Universe",
				telegramKey: "- **Simulated Universe**: {0}/{1}"
			});
		}
		if (divergentUniverse && (divergentUniverse.value !== divergentUniverse.total || tournUnlocked === false)) {
			objectives.push({
				...divergentUniverse,
				label: "Divergent Universe",
				telegramKey: "- **Divergent Universe**: {0}/{1}"
			});
		}
	}
	if (type === "nap") {
		const { bounty, surveyPoints } = progress;
		if (bounty && bounty.value !== bounty.total) {
			objectives.push({
				...bounty,
				label: "Bounty Commission",
				telegramKey: "- **Bounty Commission**: {0}/{1}"
			});
		}
		if (surveyPoints && surveyPoints.value !== surveyPoints.total) {
			objectives.push({
				...surveyPoints,
				label: "Survey Points",
				telegramKey: "- **Survey Points**: {0}/{1}"
			});
		}
	}

	return objectives;
}

RegionalTaskManager.registerTask("WeekliesReminder", 21, 0, async (account) => {
	const weekliesCheck = account.weekliesCheck;
	if (weekliesCheck === false) {
		return;
	}

	const platform = app.HoyoLab.get(account.platform);
	const notes = await platform.notes(account);
	if (notes.success === false) {
		return;
	}

	const { data } = notes;

	const platforms = app.Platform.getForAccount(account);
	const embedPlatforms = app.Platform.getEmbedPlatforms(platforms);
	const telegrams = platforms.filter(p => p.name === "telegram");
	if (embedPlatforms.length === 0 && telegrams.length === 0) {
		return;
	}

	const { type } = platform;
	const objectives = getObjectives(type, data);
	if (!objectives || (objectives.length === 0 && (type === "starrail" || type === "nap"))) {
		return;
	}

	if (embedPlatforms.length > 0) {
		const embed = {
			color: data.assets.color,
			title: t("Weeklies Reminder"),
			author: {
				name: data.assets.author,
				icon_url: data.assets.logo
			},
			description: t("Don't forget to complete your weeklies!"),
			fields: [
				{ name: "UID", value: account.uid, inline: true },
				{ name: t("Username"), value: account.nickname, inline: true },
				{ name: t("Region"), value: app.HoyoLab.getRegion(account.region), inline: true }
			],
			timestamp: new Date(),
			footer: {
				text: t("Weeklies Reminder"),
				icon_url: data.assets.logo
			}
		};

		for (const { label, value, total, embedKey } of objectives) {
			embed.fields.push({
				name: t(label),
				value: embedKey ? t(embedKey, value, total) : `${value}/${total}`,
				inline: true
			});
		}

		for (const destination of embedPlatforms) {
			const userId = destination.createUserMention(account.discord);
			await destination.send(embed, {
				content: userId,
				author: data.assets.author,
				icon: data.assets.logo,
				notificationType: "weeklies"
			});
		}
	}

	if (telegrams.length > 0) {
		const message = [
			t("📅 **Weeklies Reminder**"),
			"",
			t("👤 **Account**"),
			t `- **UID**: ${account.uid}`,
			t `- **Username**: ${account.nickname}`,
			t `- **Region**: ${app.HoyoLab.getRegion(account.region)}`,
			"",
			t("📊 **Progress**"),
			...objectives.map(({ telegramKey, value, total }) => t(telegramKey, value, total))
		];

		const escapedMessage = app.Utils.escapeCharacters(message.join("\n"));
		for (const telegram of telegrams) {
			await telegram.send(escapedMessage);
		}
	}
});

module.exports = {
	name: "weeklies-reminder",
	expression: "*/5 * * * 0",
	description: t("Reminds you to complete your weeklies."),
	code: (async function weekliesReminder () {
		// eslint-disable-next-line object-curly-spacing
		await RegionalTaskManager.executeTasks({ blacklist: ["honkai", "tot"] });
	})
};
