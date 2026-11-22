const { t } = require("../localization/index.js");
const getHttpResponseDiagnostic = require("./http-response-diagnostic.js");

function readOutcome (response, context, httpMessage, retcodeMessage = httpMessage) {
	const httpFailed = response.statusCode !== 200;
	if (!httpFailed && response.body.retcode === 0) {
		return { success: true };
	}

	app.Logger.log(context, {
		message: t(httpFailed ? httpMessage : retcodeMessage),
		args: getHttpResponseDiagnostic(response)
	});
	return {
		success: false,
		reason: httpFailed
			? `HTTP ${response.statusCode}`
			: response.body.message || `retcode ${response.body.retcode}`
	};
}

function readSignResponse (response, context) {
	return readOutcome(response, context, "Failed to sign in");
}

function readSignInfoResponse (response, context, { validateState = true } = {}) {
	const outcome = readOutcome(response, context, "Failed to get sign info", "Info returned non-zero retcode");
	if (!outcome.success) {
		return outcome;
	}

	const data = response.body.data;
	if (validateState && (!data || typeof data.is_sign !== "boolean" || !Number.isInteger(data.total_sign_day)
		|| data.total_sign_day < (data.is_sign ? 1 : 0) || typeof data.today !== "string" || !data.today)) {
		app.Logger.warn(context, "Invalid sign info received");
		return { success: false };
	}
	return {
		success: true,
		data: {
			total: data.total_sign_day,
			today: data.today,
			issign: data.is_sign
		}
	};
}

function readAwardsResponse (response, context) {
	const outcome = readOutcome(response, context, "Failed to get awards data");
	if (!outcome.success) {
		return outcome;
	}

	const awards = response.body.data.awards;
	if (awards.length === 0) {
		throw new app.Error({
			message: t("No awards data available (?)"),
			args: getHttpResponseDiagnostic(response)
		});
	}
	return { success: true, data: awards };
}

module.exports = { readSignResponse, readSignInfoResponse, readAwardsResponse };
