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
		const res = await app.Got("HoYoLabHSRGameRecordDesktopWeb", {
			url: this.#instance.config.url.notes,
			responseType: "json",
			throwHttpErrors: false,
			searchParams: {
				server: accountData.region,
				role_id: accountData.uid
			},
			headers: {
				Cookie: accountData.cookie,
				DS: app.Utils.generateDS()
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
					message: t("HoyoLab returned non-zero retcode"),
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
			currentStamina: data.current_stamina,
			maxStamina: data.max_stamina,
			recoveryTime: data.stamina_recover_time,
			reserveStamina: data.current_reserve_stamina,
			isReserveStaminaFull: data.is_reserve_stamina_full
		};

		const dailies = {
			task: data.current_train_score,
			maxTask: data.max_train_score
		};

		const weeklies = {
			weeklyBoss: data.weekly_cocoon_cnt,
			weeklyBossLimit: data.weekly_cocoon_limit,
			rogueScore: data.current_rogue_score,
			maxScore: data.max_rogue_score,
			tournScore: data.rogue_tourn_weekly_cur,
			tournMaxScore: data.rogue_tourn_weekly_max,
			tournUnlocked: data.rogue_tourn_weekly_unlocked
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
			expedition: {
				completed: data.expeditions.every(i => i.status.toLowerCase() === "finished"),
				list: data.expeditions.map(i => ({
					avatar: i.avatars,
					status: i.status,
					remaining_time: i.remaining_time
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
