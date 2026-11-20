const { t } = require("../localization/index.js");

const REDEMPTION_LINKS = {
	genshin: "https://genshin.hoyoverse.com/en/gift",
	starrail: "https://hsr.hoyoverse.com/gift",
	nap: "https://zenless.hoyoverse.com/redemption",
	tot: "https://tot.hoyoverse.com/gift/"
};
const notifications = new Map();
const NO_MANUAL_LINK_ERRORS = new Set([-2006, -2017]);

const buildMessage = (status, data) => {
	const { code, loginExpired, retcode } = data;
	const account = data.account ?? {};
	const assets = account.assets ?? data.assets ?? {};
	const gameName = account.game?.name ?? data.gameName ?? (data.gameKey ?? account.platform)?.toUpperCase() ?? t("Unknown Game");
	const accountLine = status === "manual" ? "" : `(${account.uid ?? t("Unknown UID")}) ${account.nickname ?? t("Unknown")}`;
	let title;
	let detail;
	switch (status) {
		case "success":
			title = t("Code Successfully Redeemed!");
			break;
		case "failed":
			title = loginExpired ? t("Code Redemption Paused - HoYoLAB Login Expired") : t `Code Redeem Failed! (${data.reason})`;
			if (loginExpired) {
				detail = t("Update your HoYoLAB cookie or restore automatic cookie refresh. Pending codes will be retried after the cookie is renewed.");
			}
			break;
		case "manual":
			title = t("Code Found - Manual Redemption Required");
			detail = data.reason ?? t("Redeem this code from within the game client.");
			break;
		default:
			throw new app.Error({ message: t("Unknown code redeem status received."), args: { status } });
	}

	const lines = [`\n${title}`];
	if (detail !== undefined) {
		lines.push(`\n${detail}`);
	}
	if (code) {
		lines.push(t `\nCode: ${code.code}`);
		const link = REDEMPTION_LINKS[data.gameKey ?? data.platform ?? account.platform];
		if (link && status !== "success" && !NO_MANUAL_LINK_ERRORS.has(retcode)) {
			const label = status === "manual" ? t("Redeem Online") : t("Manually Redeem Here");
			lines.push(`\n${label}: ${link}?code=${code.code}`);
		}
		if (status !== "failed" && Array.isArray(code.rewards) && code.rewards.length > 0) {
			lines.push(t `\nRewards: ${code.rewards.join(", ")}`);
		}
	}
	const description = lines.join("");
	return {
		telegram: `[${gameName}]${accountLine ? ` ${accountLine}` : ""}${description}`,
		embed: {
			color: assets.color ?? 0x5865F2,
			title: t `${gameName} Code Redeem`,
			author: { name: assets.author ?? "HoYoUtils", icon_url: assets.logo ?? null },
			description: accountLine + description,
			timestamp: new Date(),
			footer: { text: code?.code ?? "Automatic Code Redemption", icon_url: assets.logo ?? null }
		}
	};
};

const sendMessage = async (status, data) => {
	const { account, notificationKey, loginExpired, retcode } = data;
	const platforms = (status === "manual" ? app.Platform?.list : app.Platform?.getForAccount(account)) ?? [];
	if (platforms.length === 0) {
		return;
	}
	const destinations = status === "failed"
		? platforms.filter(platform => ["telegram", "webhook", "gotify"].includes(platform.name))
		: [...platforms.filter(platform => platform.name === "telegram"), ...app.Platform.getEmbedPlatforms(platforms)];
	const message = buildMessage(status, data);
	const text = app.Utils.escapeCharacters(message.telegram);
	const notified = new Set(notificationKey ? await app.Cache.get(notificationKey) ?? [] : []);
	for (const platform of destinations) {
		if (notified.has(platform.id)) {
			continue;
		}
		try {
			if (platform.name === "telegram") {
				await platform.send(text);
			}
			else {
				const options = { notificationType: loginExpired ? "cookie" : "codeRedeem" };
				if (status === "failed") {
					options.content = NO_MANUAL_LINK_ERRORS.has(retcode) ? null : platform.createUserMention(account.discord);
				}
				await platform.send(message.embed, options);
			}
			if (notificationKey) {
				notified.add(platform.id);
				await app.Cache.set({ key: notificationKey, value: [...notified]});
			}
		}
		catch (e) {
			if (!notificationKey) {
				throw e;
			}
			app.Logger.error("CodeRedeem", `Could not notify ${platform.name} (${platform.id}) for account ${account.uid}`);
		}
	}
};

const notifyRedemption = (status, data) => {
	const { account, notificationKey } = data;
	if (!notificationKey) {
		return sendMessage(status, data);
	}
	let notification = notifications.get(notificationKey);
	if (!notification) {
		notification = sendMessage(status, data)
			.catch(() => app.Logger.error("CodeRedeem", `Could not process the redemption notification for account ${account.uid}`))
			.finally(() => notifications.delete(notificationKey));
		notifications.set(notificationKey, notification);
	}
	return notification;
};

module.exports = { buildMessage, notifyRedemption };
