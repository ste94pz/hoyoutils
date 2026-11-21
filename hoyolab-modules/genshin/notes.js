const { t } = require("../../localization/index.js");
const requestNotes = require("../notes-request.js");

module.exports = class RealtimeNotes {
	/** @type {import("../template")} */
	#instance;
	#logo;
	#color;

	constructor (instance, options = {}) {
		this.#instance = instance;
		this.#logo = options.logo;
		this.#color = options.color;
	}

	async notes (accountData) {
		const assets = { logo: this.#logo, color: this.#color };
		return await requestNotes(this.#instance, accountData, assets, saveSnapshot => this.#fetchNotes(accountData, saveSnapshot));
	}

	async #fetchNotes (accountData, saveSnapshot) {
		const res = await app.Got("HoYoLabGameRecordAppWebView", {
			url: this.#instance.config.url.notes,
			responseType: "json",
			throwHttpErrors: false,
			searchParams: {
				server: accountData.region,
				role_id: accountData.uid
			},
			headers: {
				// The minimum cookie subset for this app route has not been established.
				Cookie: accountData.cookie
			}
		});

		if (res.statusCode !== 200) {
			app.Logger.log(`${this.#instance.fullName}:Notes`, {
				message: t("Failed to fetch data from hoyolab"),
				args: {
					platform: this.#instance.name,
					uid: accountData.uid,
					region: accountData.region,
					body: res.body
				}
			});

			return { success: false };
		}
		if (res.body.retcode !== 0) {
			if (res.body.retcode !== -501000) {
				app.Logger.log(`${this.#instance.fullName}:Notes`, {
					message: res.body.retcode === 10102
						? t("Enable Realtime Notes in HoYoLAB's Genshin Impact Battle Chronicle settings to access your game data.")
						: t("HoyoLab returned non-zero retcode"),
					args: {
						cause: app.HoyoLab.errorMessage(this.#instance.name, res.body.retcode),
						platform: this.#instance.name,
						uid: accountData.uid,
						region: accountData.region,
						body: res.body
					}
				});
			}

			return { success: false };
		}

		const data = res.body.data;

		const stamina = {
			currentStamina: data.current_resin,
			maxStamina: data.max_resin,
			recoveryTime: data.resin_recovery_time
		};

		const { daily_task } = data;
		const dailies = {
			task: daily_task.finished_num,
			maxTask: daily_task.total_num,
			storedAttendance: daily_task.stored_attendance,
			storedAttendanceRefresh: daily_task.stored_attendance_refresh_countdown
		};

		const weeklies = {
			resinDiscount: data.remain_resin_discount_num,
			resinDiscountLimit: data.resin_discount_num_limit
		};

		const realm = {
			currentCoin: data.current_home_coin,
			maxCoin: data.max_home_coin,
			recoveryTime: data.home_coin_recovery_time
		};

		const cacheMetadata = {
			uid: accountData.uid,
			nickname: accountData.nickname,
			lastUpdate: app.Date.now(),
			expires: app.Date.now()
		};
		const snapshot = {
			stamina,
			dailies,
			weeklies,
			realm,
			expedition: {
				completed: data.expeditions.every(i => i.status.toLowerCase() === "finished"),
				list: data.expeditions.map(i => ({
					avatar: i.avatar_side_icon,
					status: i.status,
					remaining_time: i.remained_time
				}))
			}
		};

		await saveSnapshot({ ...cacheMetadata, ...snapshot });

		return {
			success: true,
			data: {
				...snapshot,
				assets: {
					...this.#instance.config.assets,
					logo: this.#logo,
					color: this.#color
				}
			}
		};
	}
};
