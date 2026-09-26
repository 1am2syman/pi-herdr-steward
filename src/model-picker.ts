import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

export interface SearchableModelPickerItem {
	value: string;
	label: string;
	description?: string;
	kind: "action" | "model";
	searchText?: string;
}

export interface SearchableModelPickerInput {
	title: string;
	items: readonly SearchableModelPickerItem[];
	maxVisible?: number;
}

/** Pure picker state used by the TUI component and contract tests. */
export class SearchableModelPickerState {
	private query = "";
	private selectedIndex = 0;
	private scrollOffset = 0;
	private visible: SearchableModelPickerItem[];
	readonly maxVisible: number;

	constructor(private readonly items: readonly SearchableModelPickerItem[], maxVisible = 12) {
		this.maxVisible = Math.max(1, maxVisible);
		this.visible = this.filteredItems();
	}

	private filteredItems(): SearchableModelPickerItem[] {
		const actions = this.items.filter((item) => item.kind === "action");
		const models = this.items.filter((item) => item.kind === "model");
		const filteredModels = this.query.trim().length === 0
			? models
			: fuzzyFilter(models, this.query, (item) => item.searchText ?? `${item.label} ${item.description ?? ""}`);
		return [...actions, ...filteredModels];
	}

	setQuery(query: string): void {
		this.query = query;
		this.visible = this.filteredItems();
		const firstModel = this.visible.findIndex((item) => item.kind === "model");
		this.selectedIndex = query.trim().length > 0 && firstModel >= 0 ? firstModel : 0;
		this.scrollOffset = Math.max(0, this.selectedIndex - this.maxVisible + 1);
	}

	move(delta: number): void {
		if (this.visible.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.visible.length - 1, this.selectedIndex + delta));
		if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
		if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
			this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
		}
	}

	page(delta: number): void {
		this.move(delta * this.maxVisible);
	}

	getQuery(): string {
		return this.query;
	}

	getSelected(): SearchableModelPickerItem | undefined {
		return this.visible[this.selectedIndex];
	}

	getSnapshot(): {
		query: string;
		items: readonly SearchableModelPickerItem[];
		window: readonly SearchableModelPickerItem[];
		selectedIndex: number;
		scrollOffset: number;
		total: number;
		matchingModels: number;
	} {
		return {
			query: this.query,
			items: this.visible,
			window: this.visible.slice(this.scrollOffset, this.scrollOffset + this.maxVisible),
			selectedIndex: this.selectedIndex,
			scrollOffset: this.scrollOffset,
			total: this.visible.length,
			matchingModels: this.visible.filter((item) => item.kind === "model").length,
		};
	}
}

/** Open the dedicated fuzzy-searchable, scrollable model picker. */
export async function openSearchableModelPicker(
	ui: Pick<ExtensionUIContext, "custom">,
	input: SearchableModelPickerInput,
): Promise<string | undefined> {
	return ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const search = new Input();
		search.focused = true;
		const state = new SearchableModelPickerState(input.items, input.maxVisible);

		const component: Component & Focusable = {
			get focused() { return search.focused; },
			set focused(value: boolean) { search.focused = value; },
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.up)) state.move(-1);
				else if (matchesKey(data, Key.down)) state.move(1);
				else if (matchesKey(data, Key.pageUp)) state.page(-1);
				else if (matchesKey(data, Key.pageDown)) state.page(1);
				else if (matchesKey(data, Key.enter)) {
					done(state.getSelected()?.value);
					return;
				} else {
					search.handleInput(data);
					state.setQuery(search.getValue());
				}
				tui.requestRender();
			},
			invalidate(): void {
				search.invalidate();
			},
			render(width: number): string[] {
				const snapshot = state.getSnapshot();
				const rows = [
					theme.fg("accent", theme.bold(input.title)),
					`${theme.fg("dim", "Search: ")}${search.render(Math.max(1, width - 8))[0] ?? ""}`,
				];
				if (snapshot.query.trim().length > 0 && snapshot.matchingModels === 0) rows.push(theme.fg("warning", "No matching models."));
				for (const [index, item] of snapshot.window.entries()) {
					const absoluteIndex = snapshot.scrollOffset + index;
					const prefix = absoluteIndex === snapshot.selectedIndex ? "> " : "  ";
					const detail = item.description ? ` — ${item.description}` : "";
					const text = truncateToWidth(`${prefix}${item.label}${detail}`, Math.max(1, width));
					rows.push(absoluteIndex === snapshot.selectedIndex
						? theme.bg("selectedBg", theme.fg("accent", text))
						: item.kind === "action" ? theme.fg("text", text) : theme.fg("muted", text));
				}
				const position = snapshot.total === 0 ? "0/0" : `${snapshot.selectedIndex + 1}/${snapshot.total}`;
				rows.push(theme.fg("dim", `↑↓ navigate • PgUp/PgDn scroll • Enter select • Esc cancel • ${position}`));
				return rows;
			},
		};
		return component;
	});
}
