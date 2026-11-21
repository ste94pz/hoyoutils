module.exports = function projectNotesSnapshot (snapshot, { now, rate, staminaThreshold }) {
	const lastUpdate = snapshot.lastUpdate ?? snapshot.lastUpdated;
	const elapsedSeconds = lastUpdate === undefined ? 0 : Math.floor((now - lastUpdate) / 1000) + 1;
	const projected = { ...snapshot, lastUpdate: now };

	if (snapshot.stamina) {
		const { maxStamina } = snapshot.stamina;
		const cachedStamina = Number(snapshot.stamina.currentStamina) || 0;
		const cappedStamina = Math.min(maxStamina, cachedStamina + elapsedSeconds / rate);
		const currentStamina = Math.round(cappedStamina * 100) / 100;
		if (currentStamina >= maxStamina || currentStamina > staminaThreshold) {
			return null;
		}

		const cachedRecoveryTime = Number(snapshot.stamina.recoveryTime) || 0;
		const recoveryTime = Math.max(0, cachedRecoveryTime - elapsedSeconds);
		projected.stamina = { ...snapshot.stamina, currentStamina, recoveryTime };
	}

	if (snapshot.expedition && snapshot.expedition.list.length !== 0) {
		const list = [];
		for (const expedition of snapshot.expedition.list) {
			const remaining_time = Math.max(0, Number(expedition.remaining_time) - Math.round(elapsedSeconds));
			if (remaining_time <= 0) {
				return null;
			}

			list.push({ ...expedition, remaining_time });
		}

		projected.expedition = { ...snapshot.expedition, list };
	}

	if (snapshot.shop?.state === "Finished") {
		return null;
	}

	if (snapshot.realm) {
		const { currentCoin, maxCoin } = snapshot.realm;
		if (currentCoin === maxCoin) {
			return null;
		}

		const recoveryTime = Math.max(0, snapshot.realm.recoveryTime - Math.round(elapsedSeconds));
		if (recoveryTime <= 0) {
			return null;
		}

		projected.realm = { ...snapshot.realm, recoveryTime };
	}

	return projected;
};
