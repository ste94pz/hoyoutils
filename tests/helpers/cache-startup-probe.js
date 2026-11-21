// Preloaded by the offline startup tests. Run the real entry point and cache.
const { statSync } = require("node:fs");
const Got = require("../../classes/got.js");
const initializeGot = Got.initialize;

Got.initialize = async () => {
	if (process.env.CACHE_PROBE_EXPECT_REFUSAL === "1") {
		throw new Error("Got initialized before startup refused the writer");
	}
	return initializeGot.call(Got);
};

require.cache[require.resolve("../../singleton/logger.js")] = {
	loaded: true,
	exports: class {
		info () {}
	}
};

// Stop startup at command loading, before cron registration and account work.
require.cache[require.resolve("../../commands/index.js")] = {
	loaded: true,
	exports: {
		async loadCommands () {
			const lock = process.platform === "linux" ? statSync("./data/cache-writer.lock") : null;
			const seed = await app.Cache.get("seed");
			if (!await app.Cache.set({ key: "seed", value: (seed ?? 0) + 1 })) {
				throw new Error("Cache write failed");
			}
			console.log(JSON.stringify({ device: lock?.dev, inode: lock?.ino, seed: seed ?? null }));
			if (process.env.CACHE_PROBE_HOLD === "1") {
				process.stdin.resume();
			}
			// Leave the entry point pending without keeping the event loop alive.
			return new Promise(() => {});
		}
	}
};
