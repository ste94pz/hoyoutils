const timers = require("node:timers/promises");
const { t } = require("../localization/index.js");

const baseDelay = 500;
const maxDelay = 30000;

module.exports = async function requestWithEventBackoff (send, logContext, maxAttempts) {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const res = await send();
		const isRateLimited = res.body?.retcode === -500004
			|| res.statusCode === 429
			|| (typeof res.body === "string" && res.body.includes("Too Many Requests"));

		if (!isRateLimited) {
			return res;
		}
		if (attempt === maxAttempts) {
			app.Logger.warn(logContext, t `Rate limited after ${maxAttempts} attempts, giving up`);
			return res;
		}

		const maxWait = Math.min(baseDelay * 2 ** attempt, maxDelay);
		const totalDelay = Math.floor(baseDelay + Math.random() * (maxWait - baseDelay));
		app.Logger.info(logContext, t `Rate limited, retrying in ${totalDelay}ms (attempt ${attempt}/${maxAttempts})`);
		await timers.setTimeout(totalDelay);
	}
};
