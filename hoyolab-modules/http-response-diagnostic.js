module.exports = function getHttpResponseDiagnostic (response) {
	const httpStatus = response.statusCode;
	const retcode = response.body?.retcode;

	return {
		httpStatus: Number.isInteger(httpStatus) ? httpStatus : undefined,
		retcode: Number.isInteger(retcode) ? retcode : undefined
	};
};
