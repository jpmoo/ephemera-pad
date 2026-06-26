import {
	App,
	ItemView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
	moment,
	normalizePath,
} from "obsidian";

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

interface NotepadSettings {
	folder: string;
	font: string;
	fontSize: number;
	defaultColor: string;
	timestampFormat: string;
}

const DEFAULT_SETTINGS: NotepadSettings = {
	folder: "Ephemera",
	font: "",
	fontSize: 14,
	defaultColor: "#ffe08a",
	timestampFormat: "YYYY-MM-DD HH:mm",
};

const VIEW_TYPE_NOTEPAD = "ephemera-pad-view";

/* ------------------------------------------------------------------ */
/* Note model                                                          */
/* ------------------------------------------------------------------ */

type BlockType = "p" | "ul" | "ol" | "check";

interface Block {
	type: BlockType;
	checked?: boolean;
	text: string;
	start?: number; // explicit starting number for the first item of an ol run
}

interface NoteData {
	created: string; // ISO
	edited: string; // ISO
	color: string; // hex
	blocks: Block[];
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default class NotepadPlugin extends Plugin {
	settings: NotepadSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_NOTEPAD, (leaf) => new NotepadView(leaf, this));

		this.addRibbonIcon("sticky-note", "Open Ephemera Pad", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-ephemera-pad",
			name: "Open Ephemera Pad",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "new-ephemera-note",
			name: "New note",
			callback: async () => {
				await this.activateView();
				const view = this.getView();
				if (view) await view.addNote();
			},
		});

		this.addSettingTab(new NotepadSettingTab(this.app, this));
	}

	onunload() {}

	getView(): NotepadView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTEPAD);
		if (leaves.length) return leaves[0].view as NotepadView;
		return null;
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_NOTEPAD)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: VIEW_TYPE_NOTEPAD, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Refresh any open view to pick up font / folder changes.
		const view = this.getView();
		if (view) await view.fullRefresh();
	}
}

/* ------------------------------------------------------------------ */
/* The sidebar view                                                    */
/* ------------------------------------------------------------------ */

class NotepadView extends ItemView {
	plugin: NotepadPlugin;

	private files: TFile[] = [];
	private index = 0;
	private current: NoteData | null = null;
	private currentFile: TFile | null = null;

	private cardEl!: HTMLElement;
	private metaEl!: HTMLElement;
	private editorEl!: HTMLElement;
	private counterEl!: HTMLElement;
	private swatchEl!: HTMLInputElement;
	private prevBtn!: HTMLButtonElement;
	private nextBtn!: HTMLButtonElement;
	private delBtn!: HTMLButtonElement;

	private saveTimer: number | null = null;
	private lastFocusedIndex = -1;
	private activeLine = -1; // line currently being edited (calc lines expand here)
	private selecting = false; // true while a whole-note selection is being made
	private sourceMode = false; // raw Markdown textarea view
	private sourceEl: HTMLTextAreaElement | null = null;
	private sourceBtn!: HTMLButtonElement;
	private listBtns: Partial<Record<BlockType, HTMLButtonElement>> = {};

	constructor(leaf: WorkspaceLeaf, plugin: NotepadPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_NOTEPAD;
	}
	getDisplayText() {
		return "Ephemera Pad";
	}
	getIcon() {
		return "sticky-note";
	}

	async onOpen() {
		this.buildChrome();
		await this.fullRefresh();
	}

	async onClose() {
		await this.flushSave();
	}

	/* ---- structural UI ---- */

	private buildChrome() {
		const root = this.contentEl;
		root.empty();
		root.addClass("notepad-root");

		this.cardEl = root.createDiv({ cls: "np-card" });

		const mkBtn = (
			parent: HTMLElement,
			icon: string,
			title: string,
			cb: () => void
		) => {
			const b = parent.createEl("button", { cls: "np-btn", title });
			b.setText(icon);
			// Don't steal focus from the editor line, so toolbar actions
			// apply to the line the caret is actually in.
			b.onmousedown = (e) => e.preventDefault();
			b.onclick = (e) => {
				e.preventDefault();
				cb();
			};
			return b;
		};
		const group = (parent: HTMLElement) =>
			parent.createDiv({ cls: "np-bar-group" });

		// Row 1: + −   |   ◀ 1/1 ▶
		const row1 = this.cardEl.createDiv({ cls: "np-bar" });
		const actions = group(row1);
		mkBtn(actions, "+", "New note", () => this.addNote());
		this.delBtn = mkBtn(actions, "−", "Delete this note", () =>
			this.confirmDelete()
		);
		const nav = group(row1);
		this.prevBtn = mkBtn(nav, "◀", "Previous note", () =>
			this.go(this.index - 1)
		);
		this.counterEl = nav.createDiv({ cls: "np-counter" });
		this.nextBtn = mkBtn(nav, "▶", "Next note", () => this.go(this.index + 1));

		// Row 2: B I   |   • 1. ✓   |   </>
		const row2 = this.cardEl.createDiv({ cls: "np-bar" });
		const emph = group(row2);
		emph.addClass("np-fmt");
		mkBtn(emph, "B", "Bold", () => this.applyEmphasis("**")).addClass("np-b");
		mkBtn(emph, "I", "Italic", () => this.applyEmphasis("*")).addClass("np-i");
		const lists = group(row2);
		lists.addClass("np-fmt");
		this.listBtns.ul = mkBtn(lists, "•", "Bullet list", () =>
			this.setBlockType("ul")
		);
		this.listBtns.ol = mkBtn(lists, "1.", "Numbered list", () =>
			this.setBlockType("ol")
		);
		this.listBtns.check = mkBtn(lists, "✓", "Checklist", () =>
			this.setBlockType("check")
		);
		const raw = group(row2);
		this.sourceBtn = mkBtn(raw, "</>", "Raw Markdown (select / copy)", () =>
			this.toggleSource()
		);

		// Editor
		this.editorEl = this.cardEl.createDiv({
			cls: "np-editor",
			attr: { tabindex: "0" },
		});

		// Ctrl/Cmd+A selects the whole note. Handled in the capture phase at the
		// container level so it works no matter which line (editable or rendered
		// preview) currently has focus.
		this.editorEl.addEventListener(
			"keydown",
			(e) => {
				if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
					e.preventDefault();
					e.stopPropagation();
					this.selectAll();
				}
			},
			true
		);

		// When the selection spans multiple lines, copy clean Markdown for the
		// whole selection rather than the per-line DOM text (which would include
		// bullet glyphs etc.).
		this.editorEl.addEventListener("copy", (e) => this.onCopy(e));

		// Bottom row: obscured timestamps on the left, color swatch on the right.
		const foot = this.cardEl.createDiv({ cls: "np-foot" });
		this.metaEl = foot.createDiv({ cls: "np-meta" });
		this.swatchEl = makeColorSwatch(
			foot,
			this.plugin.settings.defaultColor,
			(v) => this.setColor(v)
		);
		this.swatchEl.title = "Note color";
	}

	private toggleSource() {
		this.setSourceMode(!this.sourceMode);
	}

	private setSourceMode(on: boolean) {
		if (this.sourceMode === on) return;
		this.sourceMode = on;
		this.cardEl.toggleClass("np-source-mode", on);
		this.renderEditor(on ? undefined : 0);
		if (on && this.sourceEl) this.sourceEl.focus();
		this.updateToolbarState();
	}

	// Per-line contenteditables can't share one selection, so "select the whole
	// note" switches to raw Markdown mode and selects all of it there.
	private selectAll() {
		if (!this.current) return;
		this.setSourceMode(true);
		if (this.sourceEl) {
			this.sourceEl.focus();
			this.sourceEl.select();
		}
	}

	private onCopy(e: ClipboardEvent) {
		if (!this.current) return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return;
		const idxs: number[] = [];
		this.editorEl.querySelectorAll(".np-line").forEach((line) => {
			const el = line as HTMLElement;
			if (sel.containsNode(el, true) && el.dataset.index)
				idxs.push(parseInt(el.dataset.index));
		});
		if (idxs.length <= 1) return; // single line: let the browser handle it
		idxs.sort((a, b) => a - b);
		const blocks = idxs.map((i) => this.current!.blocks[i]);
		e.clipboardData?.setData("text/plain", serializeBody(blocks));
		e.preventDefault();
	}

	/* ---- data loading ---- */

	private get folderPath(): string {
		return normalizePath(this.plugin.settings.folder || "Ephemera");
	}

	private async ensureFolder(): Promise<TFolder> {
		const path = this.folderPath;
		let f = this.app.vault.getAbstractFileByPath(path);
		if (!f) {
			await this.app.vault.createFolder(path);
			f = this.app.vault.getAbstractFileByPath(path);
		}
		if (f instanceof TFolder) return f;
		throw new Error("Notepad folder path is not a folder: " + path);
	}

	private loadFiles() {
		const folder = this.app.vault.getAbstractFileByPath(this.folderPath);
		this.files = [];
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === "md") {
					this.files.push(child);
				}
			}
		}
		// Newest on top: sort by created frontmatter, falling back to file ctime.
		this.files.sort((a, b) => this.createdMs(b) - this.createdMs(a));
	}

	private createdMs(file: TFile): number {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const c = fm?.created;
		if (typeof c === "string") {
			const t = Date.parse(c);
			if (!isNaN(t)) return t;
		}
		return file.stat.ctime;
	}

	async fullRefresh() {
		await this.flushSave();
		this.loadFiles();
		if (this.index >= this.files.length) this.index = this.files.length - 1;
		if (this.index < 0) this.index = 0;
		await this.loadCurrent();
		this.applyFont();
		this.render();
	}

	private applyFont() {
		const font = this.plugin.settings.font?.trim();
		this.cardEl.style.setProperty(
			"--np-font",
			font || "var(--font-text, inherit)"
		);
		const size = this.plugin.settings.fontSize || 14;
		this.cardEl.style.setProperty("--np-font-size", `${size}px`);
	}

	private async loadCurrent() {
		if (!this.files.length) {
			this.current = null;
			this.currentFile = null;
			return;
		}
		const file = this.files[this.index];
		this.currentFile = file;
		const raw = await this.app.vault.read(file);
		this.current = parseNote(raw, this.plugin.settings.defaultColor);
	}

	/* ---- rendering ---- */

	private render() {
		this.applyColors();
		this.renderMeta();
		this.renderCounter();
		this.renderEditor();
	}

	private applyColors() {
		const bg = this.current?.color || this.plugin.settings.defaultColor;
		const fg = deriveFg(bg);
		const faint = withAlpha(fg, 0.5);
		this.cardEl.style.setProperty("--np-bg", bg);
		this.cardEl.style.setProperty("--np-fg", fg);
		this.cardEl.style.setProperty("--np-fg-faint", faint);
		this.cardEl.style.setProperty("--np-line", withAlpha(fg, 0.18));
		this.cardEl.style.setProperty("--np-btn-bg", lighten(bg));
		if (this.swatchEl) {
			this.swatchEl.value = bg;
			if (this.swatchEl.parentElement)
				this.swatchEl.parentElement.style.backgroundColor = bg;
		}
		this.cardEl.toggleClass("np-empty", !this.current);
	}

	private renderCounter() {
		this.counterEl.setText(
			this.files.length ? `${this.index + 1} / ${this.files.length}` : "0 / 0"
		);
		// Dim the arrows when there's nowhere to page in that direction.
		const atFirst = this.index <= 0 || this.files.length === 0;
		const atLast =
			this.index >= this.files.length - 1 || this.files.length === 0;
		this.prevBtn.toggleClass("is-disabled", atFirst);
		this.prevBtn.disabled = atFirst;
		this.nextBtn.toggleClass("is-disabled", atLast);
		this.nextBtn.disabled = atLast;
		// Nothing to delete or view as raw when there are no notes.
		const noNotes = this.files.length === 0;
		this.delBtn.toggleClass("is-disabled", noNotes);
		this.delBtn.disabled = noNotes;
		this.sourceBtn.toggleClass("is-disabled", noNotes);
		this.sourceBtn.disabled = noNotes;
	}

	private renderMeta() {
		this.metaEl.empty();
		if (!this.current) {
			this.metaEl.setText("");
			return;
		}
		// + = made, Δ = edited
		const c = fmtStamp(this.current.created);
		const e = fmtStamp(this.current.edited);
		this.metaEl.setText(`+ ${c}   Δ ${e}`);
	}

	private renderEditor(focusIndex?: number, caretPos?: number) {
		this.editorEl.empty();
		this.sourceEl = null;

		if (!this.current) {
			const empty = this.editorEl.createDiv({ cls: "np-placeholder" });
			empty.setText("No notes yet. Press + to create one.");
			return;
		}

		// Raw Markdown view: one plain textarea — native select/drag/copy/edit.
		if (this.sourceMode) {
			const ta = this.editorEl.createEl("textarea", {
				cls: "np-source",
				attr: { spellcheck: "false" },
			});
			ta.value = serializeBody(this.current.blocks);
			ta.addEventListener("input", () => {
				if (!this.current) return;
				const blocks = parseBlocks(ta.value);
				this.current.blocks = blocks.length
					? blocks
					: [{ type: "p", text: "" }];
				this.touch();
			});
			this.sourceEl = ta;
			this.updateToolbarState();
			return;
		}

		// The line we're about to focus is the active (editable) one; calc
		// lines elsewhere collapse to pills.
		this.activeLine = focusIndex ?? -1;

		this.current.blocks.forEach((_block, i) => {
			const line = this.editorEl.createDiv({ cls: "np-line" });
			line.dataset.index = String(i);
			this.fillLine(line, i);
		});

		if (focusIndex !== undefined) {
			const target = this.textElAt(focusIndex);
			if (target) setCaret(target, caretPos ?? 0);
		}
		this.updateToolbarState();
	}

	private textElAt(i: number): HTMLElement | null {
		const line = this.editorEl.querySelector(
			`.np-line[data-index="${i}"]`
		) as HTMLElement | null;
		return (line?.querySelector(".np-text") as HTMLElement) ?? null;
	}

	// Rebuild just one line's contents (used to toggle a calc pill ↔ editor).
	private renderLine(i: number) {
		const line = this.editorEl.querySelector(
			`.np-line[data-index="${i}"]`
		) as HTMLElement | null;
		if (line) this.fillLine(line, i);
	}

	private fillLine(line: HTMLElement, i: number) {
		if (!this.current) return;
		const block = this.current.blocks[i];
		line.empty();
		line.toggleClass("np-p", block.type === "p");
		line.toggleClass("np-checked", block.type === "check" && !!block.checked);

		// Marker
		const marker = line.createDiv({ cls: "np-marker" });
		if (block.type === "ul") {
			marker.setText("•");
		} else if (block.type === "ol") {
			marker.setText(`${this.olNumber(i)}.`);
		} else if (block.type === "check") {
			const box = marker.createEl("input", { attr: { type: "checkbox" } });
			box.checked = !!block.checked;
			box.onclick = (e) => {
				e.stopPropagation();
				block.checked = box.checked;
				this.touch();
				this.renderLine(i);
			};
		}

		// If the line has rich content (links / formulas) and isn't being
		// edited, show a non-editable preview with pills and clickable links.
		const segs = parseInline(block.text);
		if (hasRich(segs) && this.activeLine !== i) {
			this.renderPreview(line, i, segs);
			return;
		}

		// Editable raw text
		const text = line.createDiv({
			cls: "np-text",
			attr: { contenteditable: "true", spellcheck: "true" },
		});
		text.setText(block.text);

		text.addEventListener("focus", () => {
			this.lastFocusedIndex = i;
			this.updateToolbarState();
		});
		text.addEventListener("input", () => {
			if (this.maybeExpandCommand(text, block)) return;
			block.text = text.textContent || "";
			if (this.maybeAutoFormat(text, block, i)) return;
			this.touch();
		});
		text.addEventListener("keydown", (ev) => this.onEditorKey(ev, i, text));
		text.addEventListener("blur", () => {
			// Collapse back to the pill preview once focus leaves the line.
			if (!this.current || this.selecting) return;
			const b = this.current.blocks[i];
			if (!b || !hasRich(parseInline(b.text))) return;
			window.setTimeout(() => {
				if (this.selecting) return;
				if (this.activeLine === i && document.activeElement === text) return;
				if (this.activeLine === i) this.activeLine = -1;
				this.renderLine(i);
			}, 0);
		});
	}

	// Non-editable rendering of a line: text spans with inline result pills.
	private renderPreview(line: HTMLElement, i: number, segs: InlineSeg[]) {
		const disp = line.createDiv({
			cls: "np-display",
			attr: { title: "Click to edit" },
		});
		for (const seg of segs) {
			if (seg.type === "text") {
				if (seg.text) renderEmphasis(disp, seg.text);
			} else if (seg.type === "calc") {
				const pill = disp.createSpan({ cls: "np-pill" });
				pill.setText(fmtNum(seg.value));
				pill.onclick = (e) => {
					e.stopPropagation();
					this.activate(i, seg.srcEnd);
				};
			} else if (seg.type === "wiki") {
				const a = disp.createSpan({ cls: "np-link np-link-internal" });
				a.setText(seg.label);
				a.setAttr("title", seg.target);
				a.onclick = (e) => {
					e.stopPropagation();
					this.app.workspace.openLinkText(
						seg.target,
						this.currentFile?.path ?? "",
						e.ctrlKey || e.metaKey
					);
				};
			} else {
				const a = disp.createSpan({ cls: "np-link np-link-external" });
				a.setText(seg.href);
				a.setAttr("title", seg.href);
				a.onclick = (e) => {
					e.stopPropagation();
					window.open(seg.href, "_blank");
				};
			}
		}
		disp.onclick = () => this.activate(i);
	}

	// Expand a slash command ("/t", "/[") when typed. Returns true if it handled
	// the input (so the caller skips its normal update).
	private maybeExpandCommand(text: HTMLElement, block: Block): boolean {
		const raw = text.textContent || "";
		const caret = getCaret(text);
		const before = raw.slice(0, caret);

		let replacement: string | null = null;
		if (before.endsWith("/t")) {
			replacement = moment().format(
				this.plugin.settings.timestampFormat || "YYYY-MM-DD HH:mm"
			);
		} else if (before.endsWith("/[")) {
			const file = this.app.workspace.getActiveFile();
			if (!file) {
				new Notice("No active note to link to.");
				return false;
			}
			replacement = `[[${file.basename}]]`;
		}
		if (replacement === null) return false;

		// Trigger only when the command stands alone (line start or after space).
		const preChar = before.charAt(before.length - 3);
		if (preChar !== "" && !/\s/.test(preChar)) return false;

		const start = caret - 2; // both commands are two characters
		const newText = raw.slice(0, start) + replacement + raw.slice(caret);
		block.text = newText;
		text.setText(newText);
		setCaret(text, start + replacement.length);
		this.touch();
		return true;
	}

	// Auto-convert a line into a list when it begins with a shorthand marker
	// and the user just typed the trailing space. Returns true if it converted.
	private maybeAutoFormat(el: HTMLElement, block: Block, i: number): boolean {
		const caret = getCaret(el);
		const t = block.text;
		let type: BlockType | null = null;
		let checked: boolean | undefined;
		let start: number | undefined;
		let rest = "";

		let m: RegExpMatchArray | null;
		if ((m = t.match(/^([-*]) \[([ xX])\] /))) {
			type = "check";
			checked = m[2].toLowerCase() === "x";
			rest = t.slice(m[0].length);
		} else if (block.type === "ul" && (m = t.match(/^\[([ xX])\] /))) {
			// "- " already became a bullet; "[ ] " upgrades it to a checkbox.
			type = "check";
			checked = m[1].toLowerCase() === "x";
			rest = t.slice(m[0].length);
		} else if (block.type === "p" && (m = t.match(/^[-*] /))) {
			type = "ul";
			rest = t.slice(m[0].length);
		} else if (block.type === "p" && (m = t.match(/^# /))) {
			type = "ol";
			start = 1;
			rest = t.slice(m[0].length);
		} else if (block.type === "p" && (m = t.match(/^(\d+)\. /))) {
			// Start numbering at whatever number was typed (e.g. "3." -> 3).
			type = "ol";
			start = parseInt(m[1], 10);
			rest = t.slice(m[0].length);
		}

		if (type === null || !m) return false;
		// Only when the caret is right after the marker (i.e. the just-typed space).
		if (caret !== m[0].length) return false;

		block.type = type;
		block.checked = checked;
		block.start = start;
		block.text = rest;
		this.activeLine = i;
		this.touch();
		this.renderLine(i);
		const t2 = this.textElAt(i);
		if (t2) setCaret(t2, 0);
		return true;
	}

	// Toggle a Markdown emphasis marker ("**" bold, "*" italic) on the current
	// selection, or the word under the caret when nothing is selected.
	private applyEmphasis(marker: string) {
		if (this.sourceMode || !this.current) return;
		const active = document.activeElement as HTMLElement | null;
		if (!active || !active.classList.contains("np-text")) return;
		const line = active.closest(".np-line") as HTMLElement | null;
		if (!line?.dataset.index) return;
		const i = parseInt(line.dataset.index);
		const block = this.current.blocks[i];

		const t = active.textContent || "";
		const range = getSelRange(active);
		let start = range ? range.start : getCaret(active);
		let end = range ? range.end : start;
		// No selection: act on the word under the caret.
		if (start === end) {
			while (start > 0 && !/\s/.test(t[start - 1])) start--;
			while (end < t.length && !/\s/.test(t[end])) end++;
		}

		const m = marker.length;
		const selected = t.slice(start, end);
		let newText: string;
		let newStart: number;
		let newEnd: number;

		if (t.slice(start - m, start) === marker && t.slice(end, end + m) === marker) {
			// Markers sit just outside the selection → remove them.
			newText = t.slice(0, start - m) + selected + t.slice(end + m);
			newStart = start - m;
			newEnd = end - m;
		} else if (
			selected.length >= 2 * m &&
			selected.startsWith(marker) &&
			selected.endsWith(marker)
		) {
			// Selection includes its own markers → strip them.
			const inner = selected.slice(m, selected.length - m);
			newText = t.slice(0, start) + inner + t.slice(end);
			newStart = start;
			newEnd = start + inner.length;
		} else {
			// Otherwise wrap.
			newText = t.slice(0, start) + marker + selected + marker + t.slice(end);
			newStart = start + m;
			newEnd = end + m;
		}

		block.text = newText;
		this.activeLine = i;
		this.touch();
		// Rebuilding the line blurs the old editable element, which would
		// schedule a collapse-to-preview that wipes the selection. Suppress it
		// so the toggled text stays selected for repeated toggling.
		this.selecting = true;
		this.renderLine(i);
		const el = this.textElAt(i);
		if (el) setSelRange(el, newStart, newEnd);
		window.setTimeout(() => (this.selecting = false), 0);
	}

	// Switch a line into raw editable mode and place the caret.
	private activate(i: number, caretPos?: number) {
		this.activeLine = i;
		this.renderLine(i);
		const t = this.textElAt(i);
		if (t) setCaret(t, caretPos ?? (t.textContent || "").length);
	}

	// Number for line i: the run's first item's `start` (default 1) plus offset.
	private olNumber(i: number): number {
		if (!this.current) return 1;
		const blocks = this.current.blocks;
		let j = i;
		while (j > 0 && blocks[j - 1].type === "ol") j--;
		return (blocks[j].start ?? 1) + (i - j);
	}

	// Highlight the list button matching the current line's type.
	private updateToolbarState() {
		this.sourceBtn?.toggleClass("is-active", this.sourceMode);
		const i = this.sourceMode ? -1 : this.focusedBlockIndex();
		const type =
			i >= 0 && this.current ? this.current.blocks[i].type : null;
		(["ul", "ol", "check"] as BlockType[]).forEach((t) => {
			this.listBtns[t]?.toggleClass("is-active", type === t);
		});
	}

	/* ---- editor key handling ---- */

	private onEditorKey(ev: KeyboardEvent, i: number, el: HTMLElement) {
		if (!this.current) return;
		const blocks = this.current.blocks;
		const block = blocks[i];
		const caret = getCaret(el);
		const len = (el.textContent || "").length;


		if (ev.key === "Enter" && !ev.shiftKey) {
			ev.preventDefault();
			block.text = el.textContent || "";

			// Empty list item -> exit list (convert to paragraph).
			if (block.type !== "p" && block.text === "") {
				block.type = "p";
				block.checked = undefined;
				this.touch();
				this.renderEditor(i, 0);
				return;
			}

			const before = block.text.slice(0, caret);
			const after = block.text.slice(caret);
			block.text = before;
			const next: Block = {
				type: block.type,
				text: after,
				checked: block.type === "check" ? false : undefined,
			};
			blocks.splice(i + 1, 0, next);
			this.touch();
			this.renderEditor(i + 1, 0);
			return;
		}

		if (ev.key === "Backspace" && caret === 0 && getSelLen() === 0) {
			// At start of a list item -> demote to paragraph first.
			if (block.type !== "p") {
				ev.preventDefault();
				block.type = "p";
				block.checked = undefined;
				this.touch();
				this.renderEditor(i, 0);
				return;
			}
			// At start of a paragraph -> merge with previous block.
			if (i > 0) {
				ev.preventDefault();
				const prev = blocks[i - 1];
				const mergePos = prev.text.length;
				prev.text = prev.text + (el.textContent || "");
				blocks.splice(i, 1);
				this.touch();
				this.renderEditor(i - 1, mergePos);
				return;
			}
		}

		if (ev.key === "Delete" && caret === len && getSelLen() === 0) {
			// At end -> pull next block up.
			if (i < blocks.length - 1) {
				ev.preventDefault();
				const next = blocks[i + 1];
				block.text = (el.textContent || "") + next.text;
				blocks.splice(i + 1, 1);
				this.touch();
				this.renderEditor(i, caret);
				return;
			}
		}

		if (ev.key === "ArrowUp" && caret === 0 && i > 0) {
			ev.preventDefault();
			const lines = this.editorEl.querySelectorAll(".np-text");
			const t = lines[i - 1] as HTMLElement;
			setCaret(t, (t.textContent || "").length);
		}
		if (ev.key === "ArrowDown" && caret === len && i < blocks.length - 1) {
			ev.preventDefault();
			const lines = this.editorEl.querySelectorAll(".np-text");
			const t = lines[i + 1] as HTMLElement;
			setCaret(t, 0);
		}
	}

	/* ---- toolbar actions ---- */

	private focusedBlockIndex(): number {
		const active = document.activeElement as HTMLElement | null;
		if (active && active.classList.contains("np-text")) {
			const line = active.closest(".np-line") as HTMLElement | null;
			if (line?.dataset.index) return parseInt(line.dataset.index);
		}
		// Fall back to the last line the caret was in (toolbar clicks may
		// have moved focus). -1 means "no active line".
		if (this.lastFocusedIndex >= 0 && this.current) {
			return Math.min(this.lastFocusedIndex, this.current.blocks.length - 1);
		}
		return -1;
	}

	private setBlockType(type: BlockType) {
		if (this.sourceMode) return;
		if (!this.current || !this.current.blocks.length) return;
		let i = this.focusedBlockIndex();
		if (i < 0) i = 0;
		const block = this.current.blocks[i];
		// Toggle off if already this type.
		if (block.type === type) {
			block.type = "p";
			block.checked = undefined;
		} else {
			block.type = type;
			block.checked = type === "check" ? false : undefined;
		}
		this.touch();
		this.renderEditor(i, getCaretSafe());
	}

	/* ---- navigation ---- */

	private async go(newIndex: number) {
		if (!this.files.length) return;
		const clamped = Math.max(0, Math.min(this.files.length - 1, newIndex));
		if (clamped === this.index) return;
		await this.flushSave();
		this.index = clamped;
		await this.loadCurrent();
		this.render();
	}

	/* ---- add / delete ---- */

	async addNote() {
		await this.flushSave();
		await this.ensureFolder();
		const now = new Date();
		const note: NoteData = {
			created: now.toISOString(),
			edited: now.toISOString(),
			color: this.plugin.settings.defaultColor,
			blocks: [{ type: "p", text: "" }],
		};
		const name = `Note ${stampForName(now)}.md`;
		const path = normalizePath(`${this.folderPath}/${name}`);
		await this.app.vault.create(path, serializeNote(note));
		this.loadFiles();
		this.index = this.files.findIndex((f) => f.path === path);
		if (this.index < 0) this.index = 0;
		await this.loadCurrent();
		this.render();
		// Focus first line.
		const first = this.editorEl.querySelector(".np-text") as HTMLElement | null;
		if (first) setCaret(first, 0);
	}

	private confirmDelete() {
		if (!this.currentFile) {
			new Notice("No note to delete.");
			return;
		}
		const file = this.currentFile;
		new ConfirmModal(
			this.app,
			"Delete this note?",
			`"${file.basename}" will be moved to system trash.`,
			async () => {
				await this.app.vault.trash(file, true);
				this.loadFiles();
				if (this.index >= this.files.length) this.index = this.files.length - 1;
				if (this.index < 0) this.index = 0;
				await this.loadCurrent();
				this.render();
			}
		).open();
	}

	/* ---- color ---- */

	private setColor(hex: string) {
		if (!this.current) return;
		this.current.color = hex;
		this.applyColors();
		this.touch();
	}

	/* ---- saving ---- */

	private touch() {
		if (this.current) this.current.edited = new Date().toISOString();
		this.renderMeta();
		this.scheduleSave();
	}

	private scheduleSave() {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.flushSave(), 600);
	}

	private async flushSave() {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.current || !this.currentFile) return;
		const file = this.currentFile;
		const out = serializeNote(this.current);
		try {
			const existing = await this.app.vault.read(file);
			if (existing !== out) await this.app.vault.modify(file, out);
		} catch (e) {
			// File may have been removed externally.
		}
	}
}

/* ------------------------------------------------------------------ */
/* Confirmation modal                                                  */
/* ------------------------------------------------------------------ */

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.body });
		const row = contentEl.createDiv({ cls: "np-modal-buttons" });
		const cancel = row.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		const del = row.createEl("button", { text: "Delete", cls: "mod-warning" });
		del.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class NotepadSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: NotepadPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Notes folder")
			.setDesc(
				"Vault folder where notepad notes are stored. The +/- buttons create and delete notes here."
			)
			.addDropdown((dd) => {
				const folders = this.allFolders();
				for (const f of folders) dd.addOption(f, f === "/" ? "(vault root)" : f);
				// Make sure the configured folder appears even if it does not exist yet.
				if (!folders.includes(this.plugin.settings.folder)) {
					dd.addOption(
						this.plugin.settings.folder,
						this.plugin.settings.folder + "  (will be created)"
					);
				}
				dd.setValue(this.plugin.settings.folder);
				dd.onChange(async (v) => {
					this.plugin.settings.folder = v;
					await this.plugin.saveSettings();
				});
			})
			.addText((t) => {
				t.setPlaceholder("Or type a new folder path");
				t.onChange(async (v) => {
					const val = v.trim();
					if (!val) return;
					this.plugin.settings.folder = val;
					await this.plugin.saveData(this.plugin.settings);
				});
				t.inputEl.addEventListener("blur", () => this.display());
			});

		new Setting(containerEl)
			.setName("Font")
			.setDesc(
				"Font family for note text. Leave blank to use Obsidian's text font. Example: 'Comic Sans MS', 'Georgia', 'Courier New'."
			)
			.addText((t) => {
				t.setPlaceholder("(default text font)");
				t.setValue(this.plugin.settings.font);
				t.onChange(async (v) => {
					this.plugin.settings.font = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Text size for notes, in pixels.")
			.addSlider((s) => {
				s.setLimits(10, 28, 1)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.fontSize = v;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Timestamp format")
			.setDesc(
				"Format inserted by the /t command. Uses moment.js tokens (e.g. YYYY-MM-DD HH:mm, MMM D YYYY h:mm a)."
			)
			.addText((t) => {
				t.setPlaceholder("YYYY-MM-DD HH:mm");
				t.setValue(this.plugin.settings.timestampFormat);
				t.onChange(async (v) => {
					this.plugin.settings.timestampFormat = v;
					await this.plugin.saveData(this.plugin.settings);
				});
			})
			.addExtraButton((b) => {
				b.setIcon("clock")
					.setTooltip("Preview")
					.onClick(() => {
						const fmt =
							this.plugin.settings.timestampFormat || "YYYY-MM-DD HH:mm";
						new Notice(moment().format(fmt));
					});
			});

		const colorSetting = new Setting(containerEl)
			.setName("Default note color")
			.setDesc("Color used for newly created notes.");
		const colorInput = makeColorSwatch(
			colorSetting.controlEl,
			this.plugin.settings.defaultColor,
			async (v) => {
				this.plugin.settings.defaultColor = v;
				await this.plugin.saveSettings();
			}
		);
		colorInput.title = "Default note color";
	}

	private allFolders(): string[] {
		const out: string[] = ["/"];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFolder && f.path !== "/") out.push(f.path);
		}
		out.sort();
		return out;
	}
}

/* ------------------------------------------------------------------ */
/* Parse / serialize                                                   */
/* ------------------------------------------------------------------ */

function parseNote(raw: string, defaultColor: string): NoteData {
	let body = raw;
	const fm: Record<string, string> = {};

	if (raw.startsWith("---\n")) {
		const end = raw.indexOf("\n---", 4);
		if (end !== -1) {
			const block = raw.slice(4, end);
			body = raw.slice(end + 4).replace(/^\r?\n/, "");
			for (const line of block.split("\n")) {
				const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
				if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
			}
		}
	}

	const blocks = parseBlocks(body);
	const now = new Date().toISOString();
	return {
		created: fm.created || now,
		edited: fm.edited || fm.created || now,
		color: fm.color || defaultColor,
		blocks: blocks.length ? blocks : [{ type: "p", text: "" }],
	};
}

function parseBlocks(body: string): Block[] {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	// Drop a single trailing empty line artifact.
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	return lines.map((line): Block => {
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^- \[([ xX])\]\s?(.*)$/))) {
			return { type: "check", checked: m[1].toLowerCase() === "x", text: m[2] };
		}
		if ((m = line.match(/^[-*]\s+(.*)$/))) {
			return { type: "ul", text: m[1] };
		}
		if ((m = line.match(/^(\d+)\.\s+(.*)$/))) {
			return { type: "ol", start: parseInt(m[1], 10), text: m[2] };
		}
		return { type: "p", text: line };
	});
}

function serializeNote(note: NoteData): string {
	const fm = [
		"---",
		`created: ${note.created}`,
		`edited: ${note.edited}`,
		`color: "${note.color}"`,
		"---",
		"",
	].join("\n");

	return fm + serializeBody(note.blocks) + "\n";
}

function serializeBody(blocks: Block[]): string {
	let olCount = 0;
	let inRun = false;
	return blocks
		.map((b) => {
			if (b.type === "ol") {
				if (!inRun) {
					olCount = b.start ?? 1;
					inRun = true;
				} else {
					olCount++;
				}
				return `${olCount}. ${b.text}`;
			}
			inRun = false;
			if (b.type === "ul") return `- ${b.text}`;
			if (b.type === "check") return `- [${b.checked ? "x" : " "}] ${b.text}`;
			return b.text;
		})
		.join("\n");
}

/* ------------------------------------------------------------------ */
/* Rounded color swatch (div chip + invisible color input overlay)     */
/* ------------------------------------------------------------------ */

// Native <input type="color"> won't clip its square fill to rounded corners
// reliably, so we show a styled div and overlay a transparent color input.
function makeColorSwatch(
	parent: HTMLElement,
	value: string,
	onInput: (v: string) => void
): HTMLInputElement {
	const wrap = parent.createDiv({ cls: "np-swatch" });
	wrap.style.backgroundColor = value;
	const input = wrap.createEl("input", {
		cls: "np-swatch-input",
		attr: { type: "color" },
	});
	input.value = value;
	input.oninput = () => {
		wrap.style.backgroundColor = input.value;
		onInput(input.value);
	};
	return input;
}

/* ------------------------------------------------------------------ */
/* Arithmetic (=) evaluator — safe recursive-descent, no eval          */
/* ------------------------------------------------------------------ */

function computeFormula(raw: string): number | null {
	let s = raw.trim().replace(/^=/, "");
	s = s
		.replace(/×/g, "*")
		.replace(/÷/g, "/")
		.replace(/[−–—]/g, "-");
	if (s.trim() === "") return null;
	if (!/^[\d.+\-*/()%\s]+$/.test(s)) return null;

	let i = 0;
	const skip = () => {
		while (i < s.length && /\s/.test(s[i])) i++;
	};

	function parseExpr(): number {
		let v = parseTerm();
		skip();
		while (i < s.length && (s[i] === "+" || s[i] === "-")) {
			const op = s[i++];
			const r = parseTerm();
			v = op === "+" ? v + r : v - r;
			skip();
		}
		return v;
	}
	function parseTerm(): number {
		let v = parseFactor();
		skip();
		while (i < s.length && (s[i] === "*" || s[i] === "/" || s[i] === "%")) {
			const op = s[i++];
			const r = parseFactor();
			v = op === "*" ? v * r : op === "/" ? v / r : v % r;
			skip();
		}
		return v;
	}
	function parseFactor(): number {
		skip();
		if (s[i] === "+") {
			i++;
			return parseFactor();
		}
		if (s[i] === "-") {
			i++;
			return -parseFactor();
		}
		if (s[i] === "(") {
			i++;
			const v = parseExpr();
			skip();
			if (s[i] !== ")") throw new Error("unbalanced");
			i++;
			return v;
		}
		const start = i;
		while (i < s.length && /[\d.]/.test(s[i])) i++;
		if (i === start) throw new Error("number expected");
		const n = parseFloat(s.slice(start, i));
		if (isNaN(n)) throw new Error("nan");
		return n;
	}

	try {
		const v = parseExpr();
		skip();
		if (i !== s.length) return null; // trailing junk
		return isFinite(v) ? v : null;
	} catch {
		return null;
	}
}

function fmtNum(n: number): string {
	const r = Math.round(n * 1e10) / 1e10;
	return String(r);
}

type InlineSeg =
	| { type: "text"; text: string }
	| { type: "calc"; value: number; srcEnd: number }
	| { type: "wiki"; target: string; label: string }
	| { type: "url"; href: string };

const CALC_AT = /^=([0-9.+\-*/%()×÷\s]+)/;

// Split a line into plain text and "rich" segments: [[wikilinks]], http(s)
// URLs, and =formula results. Everything else stays as text.
function parseInline(text: string): InlineSeg[] {
	const segs: InlineSeg[] = [];
	let i = 0;
	let textStart = 0;
	const pushText = (end: number) => {
		if (end > textStart)
			segs.push({ type: "text", text: text.slice(textStart, end) });
	};

	while (i < text.length) {
		// Wikilink: [[target]] or [[target|label]]
		if (text[i] === "[" && text[i + 1] === "[") {
			const close = text.indexOf("]]", i + 2);
			if (close !== -1) {
				const inner = text.slice(i + 2, close);
				if (inner.length && !inner.includes("[")) {
					const bar = inner.indexOf("|");
					const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
					const label = (bar === -1 ? inner : inner.slice(bar + 1)).trim();
					pushText(i);
					segs.push({ type: "wiki", target, label: label || target });
					i = close + 2;
					textStart = i;
					continue;
				}
			}
		}

		// URL: http:// or https:// up to whitespace, trailing punctuation trimmed
		if (text.startsWith("http://", i) || text.startsWith("https://", i)) {
			let j = i;
			while (j < text.length && !/[\s<>]/.test(text[j])) j++;
			while (j > i && /[.,;:!?'")\]]/.test(text[j - 1])) j--;
			const scheme = text.startsWith("https://", i) ? 8 : 7;
			if (j > i + scheme) {
				pushText(i);
				segs.push({ type: "url", href: text.slice(i, j) });
				i = j;
				textStart = i;
				continue;
			}
		}

		// Calc: =expression that evaluates to a finite number
		if (text[i] === "=") {
			const m = CALC_AT.exec(text.slice(i));
			if (m) {
				const expr = m[1].replace(/\s+$/, "");
				const value = expr === "" ? null : computeFormula("=" + expr);
				if (value !== null) {
					pushText(i);
					segs.push({ type: "calc", value, srcEnd: i + 1 + expr.length });
					i += 1 + expr.length;
					textStart = i;
					continue;
				}
			}
		}

		i++;
	}
	pushText(text.length);
	return segs;
}

// Matches **bold**, *italic*, or _italic_ (non-global, for testing).
const EMPH_TEST = /\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_/;

function hasRich(segs: InlineSeg[]): boolean {
	return segs.some(
		(s) => s.type !== "text" || EMPH_TEST.test(s.text)
	);
}

// Render a text run, turning Markdown emphasis into <strong>/<em>.
function renderEmphasis(parent: HTMLElement, text: string) {
	const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m.index > last)
			parent.createSpan({ text: text.slice(last, m.index) });
		if (m[1] !== undefined) parent.createEl("strong", { text: m[1] });
		else parent.createEl("em", { text: (m[2] ?? m[3]) as string });
		last = re.lastIndex;
	}
	if (last < text.length) parent.createSpan({ text: text.slice(last) });
}

/* ------------------------------------------------------------------ */
/* Color helpers                                                       */
/* ------------------------------------------------------------------ */

function hexToRgb(hex: string): [number, number, number] {
	let h = hex.replace("#", "").trim();
	if (h.length === 3)
		h = h
			.split("")
			.map((c) => c + c)
			.join("");
	const n = parseInt(h || "ffe08a", 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b),
		min = Math.min(r, g, b);
	let h = 0,
		s = 0;
	const l = (max + min) / 2;
	const d = max - min;
	if (d !== 0) {
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = (g - b) / d + (g < b ? 6 : 0);
				break;
			case g:
				h = (b - r) / d + 2;
				break;
			default:
				h = (r - g) / d + 4;
		}
		h /= 6;
	}
	return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	let r: number, g: number, b: number;
	if (s === 0) {
		r = g = b = l;
	} else {
		const hue2rgb = (p: number, q: number, t: number) => {
			if (t < 0) t += 1;
			if (t > 1) t -= 1;
			if (t < 1 / 6) return p + (q - p) * 6 * t;
			if (t < 1 / 2) return q;
			if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
			return p;
		};
		const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
		const p = 2 * l - q;
		r = hue2rgb(p, q, h + 1 / 3);
		g = hue2rgb(p, q, h);
		b = hue2rgb(p, q, h - 1 / 3);
	}
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function toHex(r: number, g: number, b: number): string {
	const h = (v: number) => v.toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`;
}

// Derive a readable, hue-matched foreground: dark-of-the-hue on light bg,
// light-of-the-hue on dark bg (e.g. dark blue text on a light blue note).
function deriveFg(bg: string): string {
	const [r, g, b] = hexToRgb(bg);
	const [h, s] = rgbToHsl(r, g, b);
	// Perceived luminance of the background.
	const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	const sat = Math.min(1, Math.max(0.45, s)); // keep it clearly tinted
	const fgL = lum > 0.5 ? 0.22 : 0.9;
	const [fr, fg, fb] = hslToRgb(h, sat, fgL);
	return toHex(fr, fg, fb);
}

// A lighter tint in the same color family (same hue), for inactive buttons.
function lighten(bg: string): string {
	const [r, g, b] = hexToRgb(bg);
	const [h, s, l] = rgbToHsl(r, g, b);
	const l2 = Math.min(0.96, l + (1 - l) * 0.5);
	const [lr, lg, lb] = hslToRgb(h, s * 0.85, l2);
	return toHex(lr, lg, lb);
}

function withAlpha(hex: string, alpha: number): string {
	const [r, g, b] = hexToRgb(hex);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

function fmtStamp(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) return "—";
	const date = d.toLocaleDateString(undefined, {
		month: "numeric",
		day: "numeric",
	});
	let h = d.getHours();
	const ap = h < 12 ? "a" : "p";
	h = h % 12 || 12;
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${date} ${h}:${m}${ap}`;
}

function stampForName(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

/* ------------------------------------------------------------------ */
/* Caret helpers (contenteditable, text-only nodes)                    */
/* ------------------------------------------------------------------ */

function getCaret(el: HTMLElement): number {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return 0;
	const range = sel.getRangeAt(0).cloneRange();
	const pre = range.cloneRange();
	pre.selectNodeContents(el);
	pre.setEnd(range.endContainer, range.endOffset);
	return pre.toString().length;
}

function getCaretSafe(): number {
	const active = document.activeElement as HTMLElement | null;
	if (active && active.classList.contains("np-text")) return getCaret(active);
	return 0;
}

function getSelLen(): number {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return 0;
	return sel.toString().length;
}

// Selection start/end as character offsets within `el` (text-only content).
function getSelRange(el: HTMLElement): { start: number; end: number } | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const r = sel.getRangeAt(0);
	if (!el.contains(r.startContainer) || !el.contains(r.endContainer))
		return null;
	const pre = r.cloneRange();
	pre.selectNodeContents(el);
	pre.setEnd(r.startContainer, r.startOffset);
	const start = pre.toString().length;
	return { start, end: start + r.toString().length };
}

// Select a character range within `el` (text-only content).
function setSelRange(el: HTMLElement, start: number, end: number) {
	if (start === end) {
		setCaret(el, start);
		return;
	}
	el.focus();
	const sel = window.getSelection();
	if (!sel) return;
	const node = el.firstChild;
	const range = document.createRange();
	if (node && node.nodeType === Node.TEXT_NODE) {
		const len = node.textContent?.length || 0;
		range.setStart(node, Math.min(start, len));
		range.setEnd(node, Math.min(end, len));
	} else {
		range.selectNodeContents(el);
	}
	sel.removeAllRanges();
	sel.addRange(range);
}

function setCaret(el: HTMLElement, pos: number) {
	el.focus();
	const sel = window.getSelection();
	if (!sel) return;
	const range = document.createRange();
	const node = el.firstChild;
	if (node && node.nodeType === Node.TEXT_NODE) {
		const p = Math.min(pos, node.textContent?.length || 0);
		range.setStart(node, p);
	} else {
		range.selectNodeContents(el);
	}
	range.collapse(true);
	sel.removeAllRanges();
	sel.addRange(range);
}
