import { StringDecoder } from "node:string_decoder";
import { Transform, Writable } from "node:stream";
import { clearLine, clearScreenDown, createInterface, cursorTo, moveCursor, } from "node:readline";
import { clipToWidth } from "./text-width.js";
const HISTORY_LIMIT = 500;
const SECRET_LIKE = /\bsk-[A-Za-z0-9_-]{8,}/u;
/** Longest prefix shared by every candidate ("" when they diverge at once). */
function commonPrefix(values) {
    let prefix = values[0] ?? "";
    for (const value of values) {
        while (prefix && !value.startsWith(prefix))
            prefix = prefix.slice(0, -1);
        if (!prefix)
            break;
    }
    return prefix;
}
/** A single trailing backslash continues the message on the next line. */
function hasContinuation(line) {
    const match = /\\+$/u.exec(line);
    return match !== null && match[0].length % 2 === 1;
}
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
function markerPrefixLength(value, marker) {
    const maximum = Math.min(value.length, marker.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
        if (marker.startsWith(value.slice(-length)))
            return length;
    }
    return 0;
}
class BracketedPasteParser {
    replacePaste;
    buffered = "";
    pasted = "";
    insidePaste = false;
    constructor(replacePaste) {
        this.replacePaste = replacePaste;
    }
    push(value) {
        this.buffered += value;
        let output = "";
        while (this.buffered.length > 0) {
            const marker = this.insidePaste ? PASTE_END : PASTE_START;
            const markerIndex = this.buffered.indexOf(marker);
            if (markerIndex >= 0) {
                const beforeMarker = this.buffered.slice(0, markerIndex);
                if (this.insidePaste)
                    this.pasted += beforeMarker;
                else
                    output += beforeMarker;
                this.buffered = this.buffered.slice(markerIndex + marker.length);
                if (this.insidePaste) {
                    output += this.replacePaste(this.pasted);
                    this.pasted = "";
                }
                this.insidePaste = !this.insidePaste;
                continue;
            }
            const retainedLength = markerPrefixLength(this.buffered, marker);
            const safeLength = this.buffered.length - retainedLength;
            const safe = this.buffered.slice(0, safeLength);
            if (this.insidePaste)
                this.pasted += safe;
            else
                output += safe;
            this.buffered = this.buffered.slice(safeLength);
            break;
        }
        return output;
    }
    finish() {
        let output = "";
        if (this.insidePaste) {
            this.pasted += this.buffered;
            output = this.replacePaste(this.pasted);
        }
        else {
            output = this.buffered;
        }
        this.buffered = "";
        this.pasted = "";
        this.insidePaste = false;
        return output;
    }
    flushPendingPrefix() {
        if (this.insidePaste || this.buffered.length === 0)
            return "";
        const output = this.buffered;
        this.buffered = "";
        return output;
    }
}
class BracketedPasteInput extends Transform {
    source;
    decoder = new StringDecoder("utf8");
    parser;
    prefixTimer;
    isTTY = true;
    isRaw = false;
    constructor(replacePaste, source) {
        super();
        this.source = source;
        this.parser = new BracketedPasteParser(replacePaste);
        this.isRaw = Boolean(source.isRaw);
    }
    setRawMode(mode) {
        this.source.setRawMode?.(mode);
        this.isRaw = mode;
        return this;
    }
    _transform(chunk, _encoding, callback) {
        if (this.prefixTimer)
            clearTimeout(this.prefixTimer);
        this.push(this.parser.push(this.decoder.write(chunk)));
        this.prefixTimer = setTimeout(() => {
            this.prefixTimer = undefined;
            this.push(this.parser.flushPendingPrefix());
        }, 25);
        this.prefixTimer.unref();
        callback();
    }
    _flush(callback) {
        if (this.prefixTimer)
            clearTimeout(this.prefixTimer);
        this.prefixTimer = undefined;
        this.push(this.parser.push(this.decoder.end()));
        this.push(this.parser.finish());
        callback();
    }
    _destroy(error, callback) {
        if (this.prefixTimer)
            clearTimeout(this.prefixTimer);
        this.prefixTimer = undefined;
        callback(error);
    }
}
export class LineInput {
    input;
    output;
    completer;
    suggestions;
    onResize;
    pasteInput;
    terminalInput;
    interface;
    queued = [];
    waiters = [];
    pastedValues = new Map();
    pasteSequence = 0;
    closed = false;
    suspending = false;
    lastPrompt = "";
    suggestionsActive = false;
    dismissedLine;
    menuCapacity = 0;
    promptEpoch = 0;
    refreshQueued = false;
    suggestionLine;
    suggestionSelection = -1;
    suggestionValues = [];
    history;
    historyEnabled = true;
    /** Nesting depth of suspendForMenu, so overlapping suspensions pair up. */
    suspendDepth = 0;
    onInterrupt;
    constructor(options = {}) {
        this.input = options.input ?? process.stdin;
        this.output = options.output ?? process.stdout;
        if (options.completer)
            this.completer = options.completer;
        if (options.suggestions)
            this.suggestions = options.suggestions;
        if (options.onResize)
            this.onResize = options.onResize;
        this.history = options.history;
        if (this.input.isTTY) {
            this.pasteInput = new BracketedPasteInput((value) => this.replacePaste(value), this.input);
            this.input.pipe(this.pasteInput);
            this.output.write(ENABLE_BRACKETED_PASTE);
        }
        this.terminalInput = this.pasteInput ?? this.input;
        this.interface = this.create(this.terminalInput);
        if (this.terminalInput.isTTY) {
            this.terminalInput.prependListener("keypress", this.handleKeypress);
            this.output.on("resize", this.handleResize);
        }
    }
    handleKeypress = (_character, key = {}) => {
        if (this.closed)
            return;
        if (key.ctrl && key.name === "l") {
            // readline clears the screen itself; forget the overlay rows that
            // scrolled away with it so the next repaint re-allocates from scratch.
            this.menuCapacity = 0;
            if (this.suggestionsActive)
                this.scheduleSuggestionRefresh();
            return;
        }
        if (!this.suggestionsActive)
            return;
        if (key.name === "escape") {
            this.suggestionSelection = -1;
            this.suggestionValues = [];
            this.dismissedLine = this.interface.line;
            this.eraseMenuFromPrompt();
            return;
        }
        if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
            if (!key.ctrl)
                this.confirmSuggestionIntoLine();
            this.promptEpoch += 1;
            this.eraseMenuFromPrompt();
            return;
        }
        if (key.name === "tab" && !key.ctrl && !key.meta && !key.shift) {
            if (this.completeFromSuggestions()) {
                // readline's default branch inserts the *character* it was handed, so
                // clearing `key.name` (enough for arrows) would still leave a literal
                // tab in the line. Routing the key into the ctrl switch drops it.
                key.ctrl = true;
                key.name = undefined;
                key.sequence = "";
                key.code = "";
                this.scheduleSuggestionRefresh();
                return;
            }
        }
        if (key.name === "up" || key.name === "down") {
            if (this.dismissedLine !== this.interface.line) {
                if (this.suggestionValues.length === 0 && this.suggestions) {
                    const menu = this.normalizeSuggestion(this.suggestions(this.interface.line, this.terminalSize(), -1));
                    this.suggestionValues = menu.values ?? [];
                    this.suggestionLine = this.interface.line;
                }
                if (this.suggestionValues.length > 0) {
                    this.moveSuggestionSelection(key.name);
                    // readline normally sends bare Up/Down to history navigation. The
                    // command palette owns those keys while it is visible, so mutate
                    // the event object before readline's own keypress listener runs.
                    key.name = undefined;
                    key.sequence = "";
                    key.code = "";
                    this.scheduleSuggestionRefresh();
                    return;
                }
            }
        }
        this.scheduleSuggestionRefresh();
    };
    moveSuggestionSelection(direction) {
        const count = this.suggestionValues.length;
        if (count === 0) {
            this.suggestionSelection = -1;
            return;
        }
        if (this.suggestionSelection < 0) {
            this.suggestionSelection = direction === "up" ? count - 1 : 0;
            return;
        }
        this.suggestionSelection =
            direction === "up"
                ? Math.max(0, this.suggestionSelection - 1)
                : Math.min(count - 1, this.suggestionSelection + 1);
    }
    /**
     * Tab completion against the live palette: takes the highlighted candidate,
     * otherwise grows the line by the prefix all candidates share. When the
     * prefix cannot grow it highlights the first candidate instead, so a second
     * Tab (or Enter) commits it. Returns whether anything changed.
     */
    completeFromSuggestions() {
        if (!this.suggestions)
            return false;
        const line = this.interface.line;
        const menu = this.normalizeSuggestion(this.suggestions(line, this.terminalSize(), this.suggestionSelection));
        const values = menu.values ?? [];
        if (values.length === 0)
            return false;
        this.suggestionValues = values;
        // Tab is an explicit request, so it reopens a palette dismissed with Esc.
        this.dismissedLine = undefined;
        const selected = this.suggestionSelection;
        const highlighted = selected >= 0 && selected < values.length ? values[selected] : undefined;
        const target = highlighted ?? commonPrefix(values);
        if (target.length > line.length) {
            this.replaceLine(target);
            this.suggestionLine = target;
            this.suggestionSelection = -1;
            return true;
        }
        if (highlighted !== undefined)
            return false;
        this.suggestionSelection = 0;
        return true;
    }
    /** Replaces the line editor's content through readline's own edit keys. */
    replaceLine(value) {
        this.interface.write(null, { ctrl: true, name: "e" });
        this.interface.write(null, { ctrl: true, name: "u" });
        if (value)
            this.interface.write(value);
    }
    confirmSuggestionIntoLine() {
        const index = this.suggestionSelection;
        if (index < 0 || index >= this.suggestionValues.length)
            return;
        const value = this.suggestionValues[index];
        if (value === undefined || this.interface.line === value)
            return;
        // readline's own keypress listener runs immediately after this
        // prepended one and will submit whatever is in `interface.line`.
        const editable = this.interface;
        editable.line = value;
        editable.cursor = value.length;
    }
    handleResize = () => {
        if (!this.suggestionsActive || this.closed)
            return;
        const epoch = this.promptEpoch;
        queueMicrotask(() => {
            if (this.closed || !this.suggestionsActive || epoch !== this.promptEpoch)
                return;
            this.clearMenuForResize();
            this.onResize?.(this.terminalSize());
            this.interface.prompt(true);
            this.refreshSuggestions();
        });
    };
    terminalSize() {
        const output = this.output;
        const rawColumns = Number.isFinite(output.columns) && output.columns > 0 ? output.columns : 80;
        const rawRows = Number.isFinite(output.rows) && output.rows > 0 ? output.rows : 24;
        return {
            columns: Math.max(16, rawColumns - 2),
            rows: Math.max(4, rawRows),
        };
    }
    scheduleSuggestionRefresh() {
        if (this.refreshQueued)
            return;
        this.refreshQueued = true;
        const epoch = this.promptEpoch;
        queueMicrotask(() => {
            this.refreshQueued = false;
            if (this.closed || !this.suggestionsActive || epoch !== this.promptEpoch)
                return;
            if (this.dismissedLine !== undefined && this.dismissedLine !== this.interface.line)
                this.dismissedLine = undefined;
            this.refreshSuggestions();
        });
    }
    refreshSuggestions() {
        if (!this.suggestions || !this.suggestionsActive || this.dismissedLine === this.interface.line) {
            this.eraseMenuFromPrompt();
            return;
        }
        if (this.interface.getCursorPos().rows > 0) {
            this.eraseMenuFromPrompt();
            return;
        }
        const line = this.interface.line;
        if (this.suggestionLine !== line) {
            this.suggestionLine = line;
            this.suggestionSelection = -1;
        }
        let menu = this.normalizeSuggestion(this.suggestions(line, this.terminalSize(), this.suggestionSelection));
        this.suggestionValues = menu.values ?? [];
        if (this.suggestionSelection >= this.suggestionValues.length) {
            this.suggestionSelection = this.suggestionValues.length > 0 ? this.suggestionValues.length - 1 : -1;
            menu = this.normalizeSuggestion(this.suggestions(line, this.terminalSize(), this.suggestionSelection));
            this.suggestionValues = menu.values ?? [];
        }
        this.paintMenu([...menu.lines]);
    }
    normalizeSuggestion(result) {
        return (Array.isArray(result) ? { lines: result } : result);
    }
    allocateMenuRows(capacity) {
        if (capacity <= this.menuCapacity)
            return;
        const additional = capacity - this.menuCapacity;
        const cursor = this.interface.getCursorPos();
        if (this.menuCapacity > 0)
            moveCursor(this.output, 0, this.menuCapacity);
        for (let index = 0; index < additional; index += 1)
            this.output.write("\r\n");
        moveCursor(this.output, 0, -capacity);
        cursorTo(this.output, cursor.cols);
        this.menuCapacity = capacity;
    }
    paintMenu(lines) {
        this.allocateMenuRows(lines.length);
        if (this.menuCapacity === 0)
            return;
        const cursor = this.interface.getCursorPos();
        this.output.write("\u001b[?25l");
        for (let index = 0; index < this.menuCapacity; index += 1) {
            moveCursor(this.output, 0, 1);
            cursorTo(this.output, 0);
            clearLine(this.output, 0);
            const line = lines[index];
            if (line)
                this.output.write(line);
        }
        moveCursor(this.output, 0, -this.menuCapacity);
        cursorTo(this.output, cursor.cols);
        this.output.write("\u001b[?25h");
    }
    eraseMenuFromPrompt() {
        if (this.menuCapacity > 0)
            this.paintMenu([]);
    }
    clearMenuForResize() {
        if (this.menuCapacity === 0)
            return;
        const cursor = this.interface.getCursorPos();
        this.output.write("\u001b[?25l");
        moveCursor(this.output, 0, 1);
        cursorTo(this.output, 0);
        clearScreenDown(this.output);
        moveCursor(this.output, 0, -1);
        cursorTo(this.output, cursor.cols);
        this.output.write("\u001b[?25h");
        this.menuCapacity = 0;
    }
    replacePaste(value) {
        if (!/[\r\n]/u.test(value))
            return value;
        const lineCount = value.split(/\r\n|\r|\n/u).length;
        const token = `[Pasted text #${String(++this.pasteSequence)} · ${String(lineCount)} lines]`;
        this.pastedValues.set(token, value);
        return token;
    }
    restorePastes(line) {
        const pastedValues = [...this.pastedValues];
        this.pastedValues.clear();
        for (const [token, value] of pastedValues)
            line = line.split(token).join(value);
        return line;
    }
    create(input) {
        const options = {
            input,
            output: this.output,
            terminal: Boolean(input.isTTY),
            historySize: 500,
            removeHistoryDuplicates: true,
            escapeCodeTimeout: 100,
        };
        if (this.completer)
            options.completer = this.completer;
        const instance = createInterface(options);
        this.seedHistory(instance);
        instance.on("line", (line) => {
            this.suggestionsActive = false;
            this.dismissedLine = undefined;
            this.menuCapacity = 0;
            this.suggestionLine = undefined;
            this.suggestionSelection = -1;
            this.suggestionValues = [];
            line = this.restorePastes(line);
            if (this.historyEnabled)
                this.recordHistory(line);
            const waiter = this.waiters.shift();
            if (waiter)
                waiter(line);
            else
                this.queued.push(line);
        });
        instance.on("SIGINT", () => this.onInterrupt?.());
        instance.on("close", () => {
            if (this.suspending)
                return;
            this.closed = true;
            this.promptEpoch += 1;
            this.terminalInput?.removeListener("keypress", this.handleKeypress);
            this.output.removeListener("resize", this.handleResize);
            if (this.pasteInput) {
                this.output.write(DISABLE_BRACKETED_PASTE);
                this.input.unpipe(this.pasteInput);
                this.pasteInput.destroy();
            }
            this.pastedValues.clear();
            for (const waiter of this.waiters.splice(0))
                waiter(undefined);
        });
        return instance;
    }
    async next(prompt, options = {}) {
        const continuation = options.continuation;
        let line = await this.readLine(prompt, options);
        if (line === undefined || continuation === undefined)
            return line;
        while (hasContinuation(line)) {
            const more = await this.readLine(continuation, {});
            if (more === undefined)
                return line.slice(0, -1);
            line = `${line.slice(0, -1)}\n${more}`;
        }
        return line;
    }
    async readLine(prompt, options) {
        if (this.queued.length > 0) {
            const queued = this.queued.shift();
            // Type-ahead captured while the prompt was suspended never went through
            // the line editor, so echo it: an unexplained reply is disorienting.
            if (queued !== undefined)
                this.output.write(`${prompt}${queued}\n`);
            return queued;
        }
        if (this.closed)
            return undefined;
        this.historyEnabled = options.history ?? true;
        this.promptEpoch += 1;
        this.lastPrompt = prompt;
        this.suggestionsActive = options.suggestions ?? false;
        this.dismissedLine = undefined;
        this.menuCapacity = 0;
        this.suggestionLine = undefined;
        this.suggestionSelection = -1;
        this.suggestionValues = [];
        this.interface.setPrompt(prompt);
        this.interface.prompt();
        return await new Promise((resolve) => this.waiters.push(resolve));
    }
    /**
     * Hands the terminal to a foreign full-screen program (`/edit` spawns
     * $EDITOR with inherited stdio). Bracketed paste is turned off for the
     * duration: left on, an editor receives the raw `[200~` markers as
     * keystrokes when the user pastes into it.
     */
    pause() {
        this.interface.pause();
        if (this.pasteInput) {
            this.output.write(DISABLE_BRACKETED_PASTE);
            this.input.pause();
        }
    }
    resume() {
        if (!this.closed) {
            this.interface.resume();
            if (this.pasteInput) {
                this.output.write(ENABLE_BRACKETED_PASTE);
                this.input.resume();
            }
        }
    }
    /**
     * Hands the terminal over to a MenuPicker: the readline interface is closed
     * (without marking this input as closed) and the paste transform detached so
     * raw keystrokes reach the picker exclusively.
     */
    suspendForMenu() {
        if (this.closed)
            return;
        // Suspensions can nest (a picker opened while a generation guard holds the
        // terminal). Only the outermost may tear the interface down: rebuilding it
        // twice leaves two live readlines on one stream, and the second one queues
        // every submitted line for replay — every command then runs twice.
        this.suspendDepth += 1;
        if (this.suspendDepth > 1)
            return;
        this.promptEpoch += 1;
        this.menuCapacity = 0;
        this.suggestionsActive = false;
        this.suggestionLine = undefined;
        this.suggestionSelection = -1;
        this.suggestionValues = [];
        this.suspending = true;
        this.interface.close();
        this.suspending = false;
        this.terminalInput?.removeListener("keypress", this.handleKeypress);
        if (this.pasteInput) {
            this.input.unpipe(this.pasteInput);
            this.pasteInput.destroy();
            this.pasteInput = undefined;
        }
        this.terminalInput = undefined;
    }
    /** Rebuilds the readline interface after a MenuPicker finished. */
    resumeFromMenu() {
        if (this.closed)
            return;
        if (this.suspendDepth === 0)
            return;
        this.suspendDepth -= 1;
        if (this.suspendDepth > 0)
            return;
        if (this.input.isTTY) {
            this.pasteInput = new BracketedPasteInput((value) => this.replacePaste(value), this.input);
            this.input.pipe(this.pasteInput);
        }
        this.terminalInput = this.pasteInput ?? this.input;
        this.interface = this.create(this.terminalInput);
        if (this.terminalInput.isTTY) {
            this.terminalInput.prependListener("keypress", this.handleKeypress);
        }
        if (this.waiters.length > 0) {
            this.interface.setPrompt(this.lastPrompt);
            this.interface.prompt();
        }
    }
    /**
     * Queues complete lines typed while the prompt was suspended (e.g. during
     * a generation). A trailing partial line without Enter is discarded, since
     * it cannot be safely restored into the line editor.
     */
    pushText(text) {
        const segments = text.split(/\r\n|\r|\n/);
        for (const line of segments.slice(0, -1)) {
            if (line.length > 0)
                this.queued.push(line);
        }
    }
    /** True while a prompt is waiting for the user to submit a line. */
    isPrompting() {
        return !this.closed && this.waiters.length > 0;
    }
    /** The text currently held by the line editor. */
    currentLine() {
        return this.closed ? "" : this.interface.line;
    }
    /** Empties the line editor and hides any visible suggestion overlay. */
    resetLine() {
        if (this.closed)
            return;
        this.replaceLine("");
        this.suggestionLine = undefined;
        this.suggestionSelection = -1;
        this.suggestionValues = [];
        this.dismissedLine = undefined;
        this.eraseMenuFromPrompt();
        this.menuCapacity = 0;
    }
    /** Prints a line above the active prompt, then redraws the prompt. */
    notice(text) {
        if (this.closed) {
            this.output.write(`${text}\n`);
            return;
        }
        this.eraseMenuFromPrompt();
        this.menuCapacity = 0;
        clearLine(this.output, 0);
        cursorTo(this.output, 0);
        this.output.write(`${text}\n`);
        this.interface.prompt(true);
    }
    seedHistory(instance) {
        const entries = this.history?.entries;
        if (!entries || entries.length === 0)
            return;
        const editable = instance;
        if (!Array.isArray(editable.history))
            return;
        editable.history = entries.slice(-HISTORY_LIMIT).reverse();
    }
    recordHistory(line) {
        const history = this.history;
        if (!history)
            return;
        const value = line.trim();
        // Skip blanks, repeats, restored multi-line pastes and anything that
        // looks like a credential — the history file lives on disk.
        if (!value || value.length > 1_000 || /[\r\n]/u.test(value))
            return;
        if (SECRET_LIKE.test(value))
            return;
        if (history.accepts && !history.accepts(value))
            return;
        if (history.entries[history.entries.length - 1] === value)
            return;
        history.entries.push(value);
        if (history.entries.length > HISTORY_LIMIT) {
            history.entries.splice(0, history.entries.length - HISTORY_LIMIT);
        }
        history.append?.(value);
    }
    close() {
        this.suspendDepth = 0;
        if (!this.closed)
            this.interface.close();
    }
}
class MutedOutput extends Writable {
    _write(_chunk, _encoding, callback) {
        callback();
    }
}
const ESCAPE_TIMEOUT_MS = 45;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;
export class MenuPicker {
    input;
    output;
    selected = 0;
    custom = "";
    printedLines = 0;
    escapeBuffer = "";
    inCsi = false;
    escapeTimer;
    settled = false;
    constructor(input, output) {
        this.input = input;
        this.output = output;
    }
    run(options) {
        if (!this.input.isTTY)
            return Promise.reject(new Error("菜单选择需要 TTY 环境"));
        // Nothing to point at: an empty list would otherwise confirm index 0.
        if (options.items.length === 0 && !options.allowCustom)
            return Promise.resolve(undefined);
        const color = options.color ?? { accent: (value) => value, muted: (value) => value };
        this.selected = Math.max(0, Math.min(options.items.length - 1, options.initial ?? 0));
        this.printedLines = 0;
        this.escapeBuffer = "";
        this.inCsi = false;
        this.settled = false;
        const width = () => {
            const columns = this.output.columns;
            return Number.isFinite(columns) && columns > 0 ? Math.max(16, Math.floor(columns) - 2) : 78;
        };
        const rowBudget = () => {
            const rows = this.output.rows;
            return Number.isFinite(rows) && rows > 0 ? Math.max(4, Math.floor(rows)) : 24;
        };
        const render = () => {
            const showCustom = Boolean(options.allowCustom && this.custom.length > 0);
            // Chrome is title + optional custom line + optional footer. One extra
            // row is reserved for the line the cursor sits on, so the repaint's
            // cursor-up can never walk off the top of a short terminal — which
            // used to shred the screen whenever the list was taller than it.
            const chrome = 1 + (showCustom ? 1 : 0) + (options.footer ? 1 : 0);
            const budget = Math.max(1, rowBudget() - chrome - 1);
            const total = options.items.length;
            let start = 0;
            let capacity = total;
            if (total > budget) {
                capacity = Math.max(1, budget - 1); // One row goes to the overflow hint.
                start = Math.max(0, Math.min(this.selected - Math.floor(capacity / 2), total - capacity));
            }
            const visible = options.items.slice(start, start + capacity);
            const lines = [color.accent(options.title)];
            visible.forEach((item, offset) => {
                const index = start + offset;
                const clipped = clipToWidth(item, width());
                lines.push(index === this.selected ? color.accent(`❯ ${clipped}`) : `  ${color.muted(clipped)}`);
            });
            const hiddenBefore = start;
            const hiddenAfter = total - start - visible.length;
            if (hiddenBefore > 0 || hiddenAfter > 0) {
                const parts = [];
                if (hiddenBefore > 0)
                    parts.push(`↑ ${String(hiddenBefore)}`);
                if (hiddenAfter > 0)
                    parts.push(`↓ ${String(hiddenAfter)}`);
                lines.push(color.muted(`  ${parts.join(" · ")} 项未显示`));
            }
            if (showCustom) {
                lines.push(`${color.accent(options.customLabel ?? "自定义：")} ${this.custom}▏`);
            }
            if (options.footer)
                lines.push(color.muted(options.footer));
            const text = lines.join("\r\n") + "\r\n";
            if (this.printedLines > 0) {
                this.output.write(`\u001b[${this.printedLines}A`);
            }
            for (let index = 0; index < this.printedLines; index += 1) {
                this.output.write("\r\u001b[2K");
            }
            this.output.write(text);
            this.printedLines = lines.length;
        };
        const clearEscapeTimer = () => {
            if (this.escapeTimer)
                clearTimeout(this.escapeTimer);
            this.escapeTimer = undefined;
        };
        let finish = () => undefined;
        const settle = (value) => {
            if (this.settled)
                return;
            this.settled = true;
            clearEscapeTimer();
            this.input.removeListener("data", onData);
            if (this.printedLines > 0) {
                this.output.write(`\u001b[${this.printedLines}A`);
                for (let index = 0; index < this.printedLines; index += 1) {
                    this.output.write("\r\u001b[2K");
                }
            }
            this.printedLines = 0;
            this.input.setRawMode?.(false);
            this.input.pause();
            finish(value);
        };
        const handleCsiFinal = (final) => {
            if (final === "A")
                this.selected = Math.max(0, this.selected - 1);
            else if (final === "B")
                this.selected = Math.min(options.items.length - 1, this.selected + 1);
            this.escapeBuffer = "";
            this.inCsi = false;
            render();
        };
        const onData = (chunk) => {
            const text = chunk.toString("utf8");
            for (const character of text) {
                if (this.settled)
                    return;
                const codePoint = character.codePointAt(0) ?? 0;
                if (this.inCsi) {
                    clearEscapeTimer();
                    if (codePoint >= CSI_FINAL_MIN && codePoint <= CSI_FINAL_MAX) {
                        handleCsiFinal(character);
                    }
                    else if (codePoint === 0x1b) {
                        this.escapeBuffer = "\u001b";
                        this.inCsi = false;
                    }
                    // Intermediate bytes (digits, ';', '1'..'9') accumulate invisibly.
                    continue;
                }
                if (this.escapeBuffer === "\u001b") {
                    clearEscapeTimer();
                    if (character === "[") {
                        this.inCsi = true;
                        continue;
                    }
                    // A lone Escape (no CSI) means cancel.
                    this.escapeBuffer = "";
                    settle(undefined);
                    return;
                }
                if (character === "\u001b") {
                    this.escapeBuffer = "\u001b";
                    // Keep this timeout referenced: on CI runners (notably Node 22)
                    // an unref'ed timer is the only remaining handle after a lone
                    // Escape, so the test runner cancels the still-pending picker.
                    this.escapeTimer = setTimeout(() => {
                        this.escapeTimer = undefined;
                        if (this.escapeBuffer === "\u001b" && !this.settled) {
                            this.escapeBuffer = "";
                            settle(undefined);
                        }
                    }, ESCAPE_TIMEOUT_MS);
                    continue;
                }
                if (character === "\r" || character === "\n") {
                    if (options.allowCustom && this.custom.trim().length > 0) {
                        settle({ kind: "custom", text: this.custom.trim() });
                    }
                    else if (options.items.length === 0) {
                        settle(undefined); // Custom-only picker with nothing typed yet.
                    }
                    else {
                        settle({ kind: "index", index: this.selected });
                    }
                    return;
                }
                if (codePoint === 0x03) {
                    settle(undefined);
                    return;
                }
                if (codePoint === 0x7f || codePoint === 0x08) {
                    if (options.allowCustom && this.custom.length > 0) {
                        this.custom = this.custom.slice(0, -1);
                        render();
                    }
                    continue;
                }
                if (/[1-9]/u.test(character) && !options.allowCustom) {
                    const index = Number(character) - 1;
                    if (index < options.items.length) {
                        this.selected = index;
                        render();
                    }
                    continue;
                }
                if (options.allowCustom && !/[\u0000-\u001f\u007f]/u.test(character)) {
                    this.custom += character;
                    render();
                }
            }
        };
        this.input.resume();
        this.input.setRawMode?.(true);
        this.input.on("data", onData);
        render();
        return new Promise((resolve) => {
            finish = resolve;
        });
    }
}
export function watchAbortKeys(input, onAbort) {
    const stream = input;
    let typed = "";
    let escapeBuffer = "";
    let inCsi = false;
    let escapeTimer;
    let aborted = false;
    let detached = false;
    const abort = () => {
        if (aborted)
            return;
        aborted = true;
        onAbort();
    };
    const clearEscapeTimer = () => {
        if (escapeTimer)
            clearTimeout(escapeTimer);
        escapeTimer = undefined;
    };
    const onData = (chunk) => {
        if (detached)
            return;
        const text = chunk.toString("utf8");
        for (const character of text) {
            if (detached)
                return;
            const codePoint = character.codePointAt(0) ?? 0;
            if (inCsi) {
                clearEscapeTimer();
                if (codePoint >= CSI_FINAL_MIN && codePoint <= CSI_FINAL_MAX) {
                    // Arrow keys and friends: ignore, but do not abort.
                    escapeBuffer = "";
                    inCsi = false;
                }
                else if (codePoint === 0x1b) {
                    escapeBuffer = "\u001b";
                    inCsi = false;
                }
                continue;
            }
            if (escapeBuffer === "\u001b") {
                clearEscapeTimer();
                if (character === "[") {
                    inCsi = true;
                    continue;
                }
                // Lone Escape means cancel the generation.
                escapeBuffer = "";
                abort();
                return;
            }
            if (character === "\u001b") {
                escapeBuffer = "\u001b";
                escapeTimer = setTimeout(() => {
                    escapeTimer = undefined;
                    if (escapeBuffer === "\u001b") {
                        escapeBuffer = "";
                        abort();
                    }
                }, ESCAPE_TIMEOUT_MS);
                escapeTimer.unref();
                continue;
            }
            if (codePoint === 0x03) {
                abort();
                continue;
            }
            typed += character;
        }
    };
    if (!stream.isTTY) {
        return { detach: () => "" };
    }
    stream.resume();
    stream.setRawMode?.(true);
    stream.on("data", onData);
    return {
        detach: () => {
            if (detached)
                return "";
            detached = true;
            clearEscapeTimer();
            stream.removeListener("data", onData);
            stream.setRawMode?.(false);
            stream.pause();
            return typed;
        },
    };
}
export async function promptSecret(prompt, options = {}) {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    if (!input.isTTY)
        return undefined;
    output.write(prompt);
    const muted = new MutedOutput();
    const secretInterface = createInterface({ input, output: muted, terminal: true, historySize: 0 });
    return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            secretInterface.close();
            output.write("\n");
            resolve(value);
        };
        secretInterface.once("SIGINT", () => finish(undefined));
        secretInterface.question("", (answer) => finish(answer));
    });
}
