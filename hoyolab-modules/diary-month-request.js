const timers = require("node:timers/promises");

const maxRetries = 3;

module.exports = async function requestDiaryMonth (send, logContext, retryCount) {
	for (let attempt = retryCount; ; attempt += 1) {
		const response = await send();
		if (response.ok && response.body?.retcode === -500001 && attempt < maxRetries) {
			app.Logger.debug(logContext, `Rate limited, retrying in 5s... (attempt ${attempt + 1}/${maxRetries})`);
			await timers.setTimeout(5000);
		}
		else {
			return response;
		}
	}
};
