import { clearLine, cursorTo } from "node:readline";
/**
 * A single-line braille spinner for in-flight work. The caller owns the text:
 * `render` is asked for a fresh line on every frame, so elapsed time, streamed
 * thinking tokens and the interrupt hint stay live while a request runs.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 90;
const REFRESH_THROTTLE_MS = 100;
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
export class Spinner {
    output;
    render;
    timer;
    frame = 0;
    startedAt = 0;
    paintedAt = 0;
    active = false;
    constructor(output, render) {
        this.output = output;
        this.render = render;
    }
    get elapsedMs() {
        return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
    }
    start() {
        if (this.active)
            return;
        this.active = true;
        this.startedAt = Date.now();
        this.frame = 0;
        if (!this.output.isTTY)
            return;
        this.output.write(HIDE_CURSOR);
        this.paint();
        this.timer = setInterval(() => {
            this.frame = (this.frame + 1) % FRAMES.length;
            this.paint();
        }, FRAME_MS);
        this.timer.unref();
    }
    /** Repaints when the rendered text depends on data that just changed. */
    refresh() {
        if (!this.active || !this.output.isTTY)
            return;
        if (Date.now() - this.paintedAt < REFRESH_THROTTLE_MS)
            return;
        this.paint();
    }
    /** Stops the animation and clears its line. Safe to call more than once. */
    stop() {
        if (!this.active)
            return;
        this.active = false;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        if (!this.output.isTTY)
            return;
        cursorTo(this.output, 0);
        clearLine(this.output, 0);
        this.output.write(SHOW_CURSOR);
    }
    paint() {
        this.paintedAt = Date.now();
        cursorTo(this.output, 0);
        clearLine(this.output, 0);
        this.output.write(this.render(FRAMES[this.frame] ?? FRAMES[0], this.elapsedMs));
    }
}
