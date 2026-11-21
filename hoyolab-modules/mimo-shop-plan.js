// Shop item status
const MimoShopItemStatus = {
	EXCHANGEABLE: 1, // Available to buy
	NOT_EXCHANGEABLE: 2, // Waiting for shared stock to be replenished
	LIMIT_REACHED: 3, // Personal limit reached
	SOLD_OUT: 4 // Out of stock
};

const MimoPolicyMode = {
	ALWAYS: "always",
	CONDITIONAL: "conditional",
	NEVER: "never"
};

const ShopPlanFormatVersion = 2;

const formatInventorySignature = (shopItems = []) => shopItems
	.map(item => {
		const id = item.id ?? "";
		const cost = Number(item.cost) || 0;
		const name = (item.policyName || item.name || "").toLowerCase();
		return `${id}:${cost}:${name}`;
	})
	.sort((a, b) => a.localeCompare(b))
	.join("|");

const matchesShopSeason = (snapshot, meta) => snapshot.versionId === meta.versionId
	&& snapshot.durationStart === meta.durationStart
	&& snapshot.durationEnd === meta.durationEnd;

const isNewInventory = (previousSnapshot, currentSnapshot) => !previousSnapshot
	|| !matchesShopSeason(previousSnapshot, currentSnapshot)
	|| previousSnapshot.signature !== currentSnapshot.signature;

const isSnapshotCompatible = (snapshot, meta) => Boolean(snapshot?.items)
	&& typeof snapshot.items === "object"
	&& snapshot.formatVersion === ShopPlanFormatVersion
	&& matchesShopSeason(snapshot, meta);

const getFutureLiability = (item, durationEnd, now) => {
	if (item.mode === MimoPolicyMode.NEVER || item.exhausted) {
		return 0;
	}

	if (item.status === MimoShopItemStatus.SOLD_OUT && !(item.nextRefreshTime > 0)) {
		return 0;
	}

	if ([MimoShopItemStatus.NOT_EXCHANGEABLE, MimoShopItemStatus.SOLD_OUT].includes(item.status) && item.nextRefreshTime > 0
		&& Number.isFinite(durationEnd) && now + item.nextRefreshTime * 1000 >= durationEnd) {
		return 0;
	}

	// Weekly restocks replenish global stock; every reward is once per version.
	return item.cost;
};

const getShopThresholds = (items, { reservePoints, durationEnd, now }) => {
	let alwaysThreshold = 0;
	let conditionalThreshold = 0;

	for (const item of items) {
		const liability = getFutureLiability(item, durationEnd, now);
		if (item.mode === MimoPolicyMode.ALWAYS) {
			alwaysThreshold += liability;
		}
		else if (item.mode === MimoPolicyMode.CONDITIONAL) {
			conditionalThreshold += liability;
		}
	}

	const rawConditional = alwaysThreshold + conditionalThreshold;

	// The configured floor applies to lottery spending, after guaranteed rewards.
	return {
		rawConditional,
		thresholdAlways: alwaysThreshold,
		thresholdConditional: Math.max(rawConditional, reservePoints)
	};
};

const buildShopPlanSnapshot = (currentSnapshot, items, now) => {
	const trackedItems = {};
	for (const item of items) {
		trackedItems[item.id] = {
			id: item.id,
			name: item.name,
			policyName: item.policyName || item.name,
			cost: item.cost,
			status: item.status,
			nextRefreshAt: item.nextRefreshTime > 0 ? now + item.nextRefreshTime * 1000 : null,
			exhausted: item.exhausted,
			updatedAt: now
		};
	}

	return {
		...currentSnapshot,
		formatVersion: ShopPlanFormatVersion,
		items: trackedItems,
		updatedAt: now
	};
};

const restoreShopPlanItems = (snapshot, now) => Object.values(snapshot.items).map(item => ({
	...item,
	nextRefreshTime: item.nextRefreshAt ? Math.max(0, (item.nextRefreshAt - now) / 1000) : 0
}));

module.exports = {
	MimoShopItemStatus,
	MimoPolicyMode,
	formatInventorySignature,
	isNewInventory,
	isSnapshotCompatible,
	getShopThresholds,
	buildShopPlanSnapshot,
	restoreShopPlanItems
};
