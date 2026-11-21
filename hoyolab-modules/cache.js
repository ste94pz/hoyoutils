const { t } = require("../localization/index.js");
const projectNotesSnapshot = require("./notes-cache-projection.js");

module.exports = class DataCache {
	static keyvCacheExpiration = 3_600_000;
	static #pending = new Map();
	static #fetches = new Map();
	#game;

	constructor (game, rate) {
		this.#game = game;
		this.rate = rate;
	}

	#key ({ region, uid }) {
		// Legacy UID keys cannot establish the game or region of their snapshot.
		return `notes:${JSON.stringify([this.#game, region, String(uid)])}`;
	}

	async set (account, value) {
		await this.fetch(account, saveSnapshot => saveSnapshot(value));
	}

	async fetch (account, operation) {
		const key = this.#key(account);
		const requestCookie = account.cookie;
		const state = DataCache.#fetches.get(key) ?? { active: 0, started: 0, supersededThrough: 0 };
		DataCache.#fetches.set(key, state);
		const order = ++state.started;
		state.active++;

		try {
			// Passport can update the account while the request or cache queue is pending.
			return await operation(value => DataCache.#withKey(key, async () => {
				if (!app.Cache || requestCookie !== account.cookie || order <= state.supersededThrough) {
					return;
				}
				const saved = await app.Cache.set({ key, value, expiry: DataCache.keyvCacheExpiration });
				if (saved !== false) {
					state.supersededThrough = order;
				}
			}));
		}
		finally {
			if (--state.active === 0) {
				DataCache.#fetches.delete(key);
			}
		}
	}

	async get (account) {
		const key = this.#key(account);
		try {
			return await DataCache.#withKey(key, async () => {
				if (app.Cache) {
					const cachedData = await app.Cache.get(key);
					if (cachedData) {
						app.Logger.debug("Cache", t `Cache hit for key: ${this.#game} (keyv)`);

						return await this.#updateCachedData(key, cachedData, account.stamina.threshold);
					}
				}

				app.Logger.debug("Cache", t `Cache miss for key: ${this.#game}`);
				return null;
			});
		}
		catch (e) {
			console.error({
				message: t("An error while getting the key"),
				e
			});
			return null;
		}
	}

	async #updateCachedData (key, cachedData, staminaThreshold) {
		const now = Date.now();
		const expiration = DataCache.keyvCacheExpiration - (now - cachedData.expires);
		const projectedData = projectNotesSnapshot(cachedData, { now, rate: this.rate, staminaThreshold });
		if (expiration <= 0 || projectedData === null) {
			await this.#delete(key);
			return null;
		}

		await app.Cache.set({ key, value: projectedData, expiry: expiration });

		return projectedData;
	}

	async invalidateCache (account) {
		const key = this.#key(account);
		await DataCache.#withKey(key, async () => {
			const state = DataCache.#fetches.get(key);
			if (state) {
				state.supersededThrough = state.started;
			}
			await this.#delete(key);
		});
	}

	static async #withKey (key, operation) {
		// Keep the read and its write or delete together on the same backend key.
		const previous = DataCache.#pending.get(key) ?? Promise.resolve();
		const pending = previous.then(operation, operation);
		DataCache.#pending.set(key, pending);
		try {
			return await pending;
		}
		finally {
			if (DataCache.#pending.get(key) === pending) {
				DataCache.#pending.delete(key);
			}
		}
	}

	async #delete (key) {
		try {
			if (app.Cache) {
				await app.Cache.delete(key, { durable: true });
			}
			app.Logger.debug("Cache", t `Invalidated cache for key: ${this.#game}`);
		}
		catch (e) {
			app.Logger.error("Cache", t `Error invalidating cache for key ${this.#game}: ${e.message}`);
		}
	}
};
