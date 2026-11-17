// The Stream Deck models T3 Deck ships profiles for. Each one gets a "Desktop" and a
// "Code" profile, saved as `T3 Deck <profile><suffix>.streamDeckProfile` (the Stream
// Deck + keeps the plain names). The keys and dials work on any deck; models not listed
// here just get no profiles, so the deck is never switched for them.
// `type` is the SDK's DeviceType, `model` is what a profile file says it was made for.
export const DECKS = [
	{ type: 7, id: "plus", name: "Stream Deck +", suffix: "", model: "20GBD9901", cols: 4, rows: 2, dials: 4 },
	{ type: 0, id: "mk2", name: "Stream Deck MK.2 (15 keys)", suffix: " MK2", model: "20GAA9902", cols: 5, rows: 3, dials: 0 },
	{ type: 2, id: "xl", name: "Stream Deck XL", suffix: " XL", model: "20GAT9902", cols: 8, rows: 4, dials: 0 },
];

export const PROFILES = ["Desktop", "Code"];

export const deckFor = (type) => DECKS.find((d) => d.type === Number(type)) || null;

/** The profile name (as in the manifest) of a T3 Deck profile on a deck type, or null when that deck has none. */
export function profileName(profile, type) {
	const d = deckFor(type);
	return d ? `T3 Deck ${profile}${d.suffix}` : null;
}
