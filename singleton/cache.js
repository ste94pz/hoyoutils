const { t } = require("../localization/index.js");

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { dirname } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const Keyv = require("keyv");
const { KeyvFile, defaultOpts } = require("keyv-file");

class RecoverableKeyvFile extends KeyvFile {
	#pendingSave;
	#saveTail = Promise.resolve();

	save () {
		this.clearExpire();
		if (!this.#pendingSave) {
			const write = async () => {
				await delay(defaultOpts.writeDelay);
				// saveToDisk captures synchronously. Later mutations need the next save.
				this.#pendingSave = undefined;
				await this.saveToDisk();
			};
			this.#pendingSave = this.#saveTail.then(write, write);
			this.#saveTail = this.#pendingSave;
			// KeyvFile.delete discards this promise. Callers awaiting it still receive errors.
			this.#pendingSave.catch(() => {});
		}
		return this.#pendingSave;
	}

	async deleteDurably (key) {
		// KeyvFile.delete calls save synchronously and returns only the deletion result.
		const deleted = this.delete(key);
		if (deleted) {
			await this.#pendingSave;
		}
		return deleted;
	}

	async saveToDisk () {
		// Keep the KeyvFile snapshot format and capture it before any asynchronous work.
		const { filename } = this._opts;
		const data = this._opts.encode({ cache: Array.from(this._cache), lastExpire: this._lastExpire });
		const temporary = `${filename}.${randomUUID()}.tmp`;
		await fs.mkdir(dirname(filename), { recursive: true });
		const file = await fs.open(temporary, "wx", 0o600);
		try {
			try {
				await file.writeFile(data);
			}
			finally {
				await file.close();
			}
			await fs.rename(temporary, filename);
		}
		catch (e) {
			await fs.unlink(temporary).catch(() => {});
			throw e;
		}
	}
}

const isValidInteger = (value) => {
	if (typeof value !== "number") {
		return false;
	}

	return Boolean(Number.isFinite(value) && Math.trunc(value) === value);
};

module.exports = class Cache {
	#store;
	#file;

	constructor () {
		this.#file = new RecoverableKeyvFile({
			filename: "./data/cache.json",
			serialize: JSON.stringify,
			deserialize: JSON.parse
		});
		this.#store = new Keyv({ store: this.#file });
	}

	async set (data = {}) {
		if (typeof data.value === "undefined") {
			throw new app.Error({
				message: t("Provided value must not be undefined")
			});
		}

		let key = Cache.resolveKey(data.key);
		if (typeof data.specificKey === "string") {
			key += `-${data.specificKey}`;
		}

		if (data.expiry) {
			if (!isValidInteger(data.expiry)) {
				throw new app.Error({
					message: t("If provided, expiry must be a valid positive integer"),
					args: { data }
				});
			}

			return await this.#store.set(key, data.value, data.expiry);
		}

		// Keyv.set already awaits the save from KeyvFile, including for durable writers.
		return await this.#store.set(key, data.value);
	}

	async get (keyIdentifier) {
		const key = Cache.resolveKey(keyIdentifier);
		return await this.#store.get(key);
	}

	async delete (keyIdentifier, { durable = false } = {}) {
		const key = Cache.resolveKey(keyIdentifier);
		if (durable) {
			return await this.#file.deleteDurably(this.#store._getKeyPrefix(key));
		}
		return await this.#store.delete(key);
	}

	/**
	 * Cleans up and destroys the singleton caching instance
	 */
	destroy () {
		this.#store = null;
	}

	static resolveKey (value) {
		if (value === null || typeof value === "undefined") {
			throw new app.Error({
				message: t("Cannot use null or undefined as key")
			});
		}

		if (typeof value?.getCacheKey === "function") {
			return value.getCacheKey();
		}
		else if (typeof value !== "object") {
			return String(value);
		}
		else {
			throw new app.Error({
				message: t("Cannot stringify a non-primitive value"),
				args: {
					value
				}
			});
		}
	}
};
