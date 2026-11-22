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
		const res = await app.Got("HoYoLabZZZGameRecordAppWebView", {
			url: this.#instance.config.url.notes,
			responseType: "json",
			throwHttpErrors: false,
			searchParams: {
				server: accountData.region,
				role_id: accountData.uid
			},
			headers: {
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
					message: t("HoyoLab returned non-zero retcode"),
					args: {
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
		if (!data) {
			return { success: false, error: t("No data received from API") };
		}

		// Howl daily scratch card.
		const cardSign = (data.card_sign && data.card_sign === "CardSignDone") ? "Completed" : "Not Completed";

		const stamina = data.energy
			? { currentStamina: data.energy.progress?.current ?? 0, maxStamina: data.energy.progress?.max ?? 0, recoveryTime: data.energy.restore ?? 0 }
			: null;

		const dailies = data.vitality
			? { task: data.vitality.current ?? 0, maxTask: data.vitality.max ?? 0 }
			: null;

		const { num: bounty, total: bountyTotal } = data.bounty_commission ?? {};
		const { num: surveyPoints, total: surveyPointsTotal } = data.survey_points ?? {};

		const ShopState = {
			SaleStateNo: "Closed",
			SaleStateDoing: "Open",
			SaleStateDone: "Finished"
		};

		const shop = data.vhs_sale ? { state: ShopState[data.vhs_sale.sale_state] ?? "Unknown" } : null;

		if (!stamina || !dailies) {
			app.Logger.warn(`${this.#instance.fullName}:Notes`, {
				message: t("No necessary data was received from hoyolab"),
				args: {
					platform: this.#instance.name,
					uid: accountData.uid,
					region: accountData.region,
					body: res.body
				}
			});

			return { success: false };
		}

		const snapshot = {
			cardSign,
			stamina,
			dailies,
			weeklies: {
				bounty: bounty ?? 0,
				bountyTotal: bountyTotal ?? 0,
				surveyPoints: surveyPoints ?? 0,
				surveyPointsTotal: surveyPointsTotal ?? 0
			},
			weekliesPresence: {
				bounty: Number.isFinite(bounty) && Number.isFinite(bountyTotal),
				surveyPoints: Number.isFinite(surveyPoints) && Number.isFinite(surveyPointsTotal)
			},
			shop
		};

		await saveSnapshot({
			uid: accountData.uid,
			nickname: accountData.nickname,
			lastUpdate: app.Date.now(),
			expires: app.Date.now(),
			...snapshot
		});

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
