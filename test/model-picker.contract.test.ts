import { deepStrictEqual, equal } from "node:assert/strict";
import { it } from "vitest";

import { SearchableModelPickerState, type SearchableModelPickerItem } from "../src/model-picker.ts";

function models(count: number): SearchableModelPickerItem[] {
	return Array.from({ length: count }, (_, index) => ({
		kind: "model" as const,
		value: `model:provider/model-${index}`,
		label: `provider/model-${index}`,
		description: index === 42 ? "Claude Spectacular Reasoner" : `Model ${index}`,
		searchText: `provider/model-${index} ${index === 42 ? "Claude Spectacular Reasoner" : `Model ${index}`}`,
	}));
}

it("fuzzy searches provider, model id, and display name while preserving exact references", () => {
	const state = new SearchableModelPickerState([
		{ kind: "action", value: "action:exact", label: "Enter exact model choice" },
		...models(100),
	], 10);
	state.setQuery("cld spc rsn");
	const snapshot = state.getSnapshot();
	deepStrictEqual(snapshot.items.map((item) => item.value), ["action:exact", "model:provider/model-42"]);
	equal(state.getSelected()?.value, "model:provider/model-42");
});

it("keeps a bounded viewport and scrolls through long catalogues", () => {
	const state = new SearchableModelPickerState(models(125), 12);
	for (let index = 0; index < 80; index += 1) state.move(1);
	let snapshot = state.getSnapshot();
	equal(snapshot.window.length, 12);
	equal(snapshot.selectedIndex, 80);
	equal(snapshot.scrollOffset, 69);
	equal(snapshot.window.at(-1)?.value, "model:provider/model-80");
	state.page(1);
	snapshot = state.getSnapshot();
	equal(snapshot.selectedIndex, 92);
	equal(snapshot.scrollOffset, 81);
});

it("pins actions above filtered model results and resets selection on query changes", () => {
	const state = new SearchableModelPickerState([
		{ kind: "action", value: "action:current", label: "Keep current" },
		{ kind: "action", value: "action:cancel", label: "Cancel" },
		...models(30),
	], 8);
	state.move(7);
	state.setQuery("model-29");
	const snapshot = state.getSnapshot();
	deepStrictEqual(snapshot.items.map((item) => item.value), ["action:current", "action:cancel", "model:provider/model-29"]);
	equal(snapshot.selectedIndex, 2);
	equal(snapshot.scrollOffset, 0);
	equal(snapshot.matchingModels, 1);
});

it("distinguishes pinned actions from an empty model search", () => {
	const state = new SearchableModelPickerState([
		{ kind: "action", value: "action:cancel", label: "Cancel" },
		...models(10),
	], 8);
	state.setQuery("definitely-no-such-model");
	const snapshot = state.getSnapshot();
	equal(snapshot.total, 1);
	equal(snapshot.matchingModels, 0);
	equal(state.getSelected()?.value, "action:cancel");
});
