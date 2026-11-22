const { t } = require("../localization/index.js");

function buildCheckInFields (message) {
	const fields = [
		{ name: "UID", value: message.uid, inline: true },
		{ name: t("Username"), value: message.username, inline: true },
		{ name: t("Region"), value: message.region, inline: true }
	];

	if (!message.failed) {
		fields.push(
			{ name: t("Rank"), value: message.rank, inline: true },
			{ name: t("Today's Reward"), value: `${message.award.name} x${message.award.count}`, inline: true },
			{ name: t("Total Sign-ins"), value: message.total, inline: true }
		);
	}
	fields.push({ name: t("Result"), value: message.result, inline: !message.failed });

	return message.platform === "tot"
		? fields.filter(field => field.name !== t("Username") && field.name !== t("Rank"))
		: fields;
}

function buildCheckInText (message, title) {
	const lines = [
		title,
		`🆔 **(${message.uid})** ${message.username}`,
		t `🌍 **Region:** ${message.region}`
	];

	if (!message.failed) {
		lines.push(
			t `🏆 **Rank:** ${message.rank}`,
			t `🎁 **Today's Reward:** ${message.award.name} x${message.award.count}`,
			t `📅 **Total Sign-ins:** ${message.total}`
		);
	}
	lines.push(t `📝 **Result:** ${message.result}`);
	return lines.join("\n");
}

module.exports = { buildCheckInFields, buildCheckInText };
