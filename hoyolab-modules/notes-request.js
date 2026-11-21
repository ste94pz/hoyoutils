module.exports = async function requestNotes (instance, account, { logo, color }, fetchNotes) {
	const cachedData = await instance.dataCache.get(account);

	const { threshold } = account.stamina;
	if (cachedData && cachedData.stamina.currentStamina < threshold) {
		return {
			success: true,
			data: {
				...cachedData,
				assets: { ...instance.config.assets, logo, color }
			}
		};
	}

	return await instance.dataCache.fetch(account, fetchNotes);
};
