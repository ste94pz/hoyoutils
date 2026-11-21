const { spawnSync } = require("node:child_process");
const { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } = require("node:fs");

module.exports = function acquireCacheWriterLock () {
	if (process.platform !== "linux") {
		return;
	}

	mkdirSync("./data", { recursive: true });
	const path = "./data/cache-writer.lock";
	const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
	const fd = openSync(path, flags, 0o600);
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.nlink !== 1n) {
			throw new Error("Invalid writer lock file");
		}

		// flock operates on the inherited open file description. Keep fd open
		// in Node so the kernel releases the lock only when the worker exits.
		const result = spawnSync("flock", ["-n", "3"], {
			stdio: ["ignore", "ignore", "inherit", fd],
			timeout: 5000
		});
		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(`flock exited with ${result.status ?? result.signal}`);
		}

		const current = lstatSync(path, { bigint: true });
		if (opened.dev !== current.dev || opened.ino !== current.ino || current.nlink !== 1n) {
			throw new Error("Writer lock identity changed");
		}
	}
	catch (e) {
		closeSync(fd);
		throw e;
	}
};
