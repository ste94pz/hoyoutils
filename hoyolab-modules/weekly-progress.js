function readPair (value, total, present = true) {
	return present && Number.isFinite(value) && Number.isFinite(total) ? { value, total } : null;
}

function readZenlessPair (value, total, present) {
	// Older snapshots used zero for missing fields before recording presence.
	return readPair(value, total, present ?? (value !== 0 && total !== 0));
}

module.exports = function readWeeklyProgress (type, { weeklies, weekliesPresence }) {
	if (!weeklies) {
		return null;
	}
	if (type === "genshin") {
		return { resinDiscount: readPair(weeklies.resinDiscount, weeklies.resinDiscountLimit) };
	}
	if (type === "starrail") {
		const { weeklyBoss, weeklyBossLimit, rogueScore, maxScore, tournScore, tournMaxScore, tournUnlocked } = weeklies;
		return {
			boss: readPair(weeklyBoss, weeklyBossLimit),
			simulatedUniverse: readPair(rogueScore, maxScore),
			divergentUniverse: readPair(tournScore, tournMaxScore),
			tournUnlocked
		};
	}
	if (type === "nap") {
		const { bounty, bountyTotal, surveyPoints, surveyPointsTotal } = weeklies;
		return {
			bounty: readZenlessPair(bounty, bountyTotal, weekliesPresence?.bounty),
			surveyPoints: readZenlessPair(surveyPoints, surveyPointsTotal, weekliesPresence?.surveyPoints)
		};
	}
	return {};
};
