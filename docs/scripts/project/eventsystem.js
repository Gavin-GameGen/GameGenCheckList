// eventsystem.js
// Events: a mentor starts a named event for a number of minutes, and every
// student's view shows it until it runs out or someone cancels it.
//
// One event runs at a time, for the whole site (events.sql). Any mentor or
// admin can start one or cancel the running one. Starting a new event ends
// the one that was running.
//
// MENTOR VIEW - the slide-up panel (initEventBox)
//   * MSpriteEventBoxBG is placed in the editor just below the bottom edge of
//     the layout, so only its "^" tab shows in the bottom-right corner.
//     Wherever it is placed there is where it slides back to; the open
//     position is flush with the bottom edge.
//   * Tap the tab and the panel slides up; tap it again (or press Escape) and
//     it slides back down.
//   * The panel holds the event name, the duration in minutes (with 15 / 30 /
//     45 / 60 shortcuts) and a Start Event button. While an event is running
//     it shows which one, how long is left and who started it, and the Start
//     button is swapped for Cancel Event (tap twice to confirm, since it ends
//     the event for every student).
//   * The fields and buttons are real HTML, for the same reason as the search
//     bar (studentsearch.js): the project has no Text Input object. They sit
//     on top of the sprite and follow it as it slides, so moving or resizing
//     the sprite in the editor moves the panel too.
//
// STUDENT VIEW - the banner (initStudentEvent)
//   * SSpriteEvent and STextEventInfo are hidden until an event is running,
//     then fade in with the event's name and a countdown, and hide again when
//     it runs out or is cancelled. Not shown while the weekend lock is on.
//
// HOW THE NEWS GETS AROUND
//   Both views ask Supabase for the running event every EVENTS.pollSeconds
//   (one tiny read), straight away when the app comes back to the foreground,
//   and never while the tab is hidden. No Realtime channel is used. The
//   database sends back how many seconds are left and the countdown runs
//   locally from there, so it ends on time to the second even between checks
//   and even if a computer's clock is wrong. Starting or cancelling shows up
//   for students within one poll.

import { api, isMockMode } from "./data.js";
import { isWeekendLocked } from "./schedule.js";
import { closeDetailBox } from "./detailbox.js";

// ---------------------------------------------------------------- tuning
export const EVENTS = {
	pollSeconds:     15,    // how often each open view checks for the running event
	mockPollSeconds:  2,    // same, in mock mode (it's only reading localStorage)

	defaultMinutes:  30,
	presets:         [15, 30, 45, 60],
	maxMinutes:     480,    // keep in step with start_event in events.sql
	maxNameLength:   60,    // same

	slideSeconds:  0.35,
	fadeSeconds:   0.3,     // student banner fade-in
	confirmSeconds:  3,     // how long "Tap again to cancel" waits

	// The MSpriteEventBoxBG image is 825 x 725: the "^" tab is the top-right
	// corner (x 704-825, y 0-54) and the panel is everything below y 54.
	// These are image pixels; if the sprite is resized they scale with it.
	image:  { width: 825, height: 725 },
	tab:    { left: 704, bottom: 54 },
	panelTop: 54,

	// What STextEventInfo says. `name` has already had [ and ] swapped out so
	// an event name can't break the BBCode.
	studentText: (name, timeLeft) => `[b]${name}[/b]\nEnds in ${timeLeft}`
};

const COLORS = {
	text:    "#e8e8e8",
	dim:     "#9a9a9a",
	field:   "#2f2f2f",
	border:  "#6a6a6a",
	live:    "#7ee08a",
	start:   "#3f9a4f",
	cancel:  "#b84a4a",
	preset:  "#555555",
	error:   "#ff9a8a"
};

// ================================================================ the watcher
// Shared by both views: keeps track of the running event.

function watchEvent(runtime, onChange) {
	const w = {
		event: null,          // { event_id, name, seconds_left, started_by_name } or null
		receivedAt: 0,        // performance.now() when `event` arrived
		token: 0,
		timer: 0,
		stopped: false,
		askedAfterEnd: false
	};

	const pollMs = () => 1000 * Math.max(1, isMockMode() ? EVENTS.mockPollSeconds : EVENTS.pollSeconds);

	// Ask the database now.
	w.refresh = async () => {
		if (w.stopped) return;
		const token = ++w.token;
		try {
			const e = await api.getCurrentEvent();
			if (w.stopped || token !== w.token) return;     // something newer came in meanwhile
			w.set(e);
		} catch (err) {
			// Keep showing what we had; the next check will try again.
			console.warn("[events] couldn't check for a running event:", err?.message ?? err);
		}
	};

	// Take a fresh answer (from a poll, or from starting / cancelling here).
	w.set = e => {
		w.token++;                                          // drops any poll still on its way
		w.event = e && Number(e.seconds_left) > 0 ? e : null;
		w.receivedAt = performance.now();
		w.askedAfterEnd = false;
		onChange?.();
	};

	w.secondsLeft = () =>
		w.event ? Number(w.event.seconds_left) - (performance.now() - w.receivedAt) / 1000 : 0;

	// The running event, or null once its time is up.
	w.current = () => {
		if (!w.event) return null;
		if (w.secondsLeft() > 0) return w.event;
		// Ran out locally: check once in case someone has started another.
		if (!w.askedAfterEnd) {
			w.askedAfterEnd = true;
			w.refresh();
		}
		return null;
	};

	const loop = () => {
		clearTimeout(w.timer);
		if (w.stopped) return;
		w.timer = setTimeout(() => {
			if (typeof document === "undefined" || !document.hidden) w.refresh();
			loop();
		}, pollMs());
	};
	const onResume = () => w.refresh();

	w.stop = () => {
		if (w.stopped) return;
		w.stopped = true;
		clearTimeout(w.timer);
		runtime.removeEventListener("resume", onResume);
		runtime.removeEventListener("beforeanylayoutend", w.stop);
	};

	runtime.addEventListener("resume", onResume);
	runtime.addEventListener("beforeanylayoutend", w.stop);
	w.refresh();
	loop();
	return w;
}

// ================================================================ mentor panel

let box = null;
// {
//   runtime, layout, sprite, closedY, openY,
//   progress (0 closed .. 1 open), target (0 or 1),
//   watcher, ui: { root, ...elements }, busy, confirmUntil, styleKey, onTick
// }

// Call once from the mentor layout's "On start of layout".
//   box     name of the panel sprite (default "MSpriteEventBoxBG")
//   onOpen  optional, called as the panel starts opening
export function initEventBox(runtime, opts = {}) {
	destroyEventBox();

	if (typeof document === "undefined") {
		console.error("[events] needs the page's document - is the project set to run in a worker?");
		return;
	}
	const name = opts.box ?? "MSpriteEventBoxBG";
	const sprite = runtime.objects[name]?.getFirstInstance();
	if (!sprite) {
		console.error(`[events] there is no ${name} on this layout`);
		return;
	}

	box = {
		runtime, opts, sprite,
		layout: runtime.layout,
		closedY: sprite.y,
		openY: runtime.layout.height - sprite.height * (1 - originY(sprite)),
		progress: 0,
		target: 0,
		busy: false,
		confirmUntil: 0,
		styleKey: "",
		shownKey: "",
		ui: buildPanel(),
		watcher: null,
		onTick: () => tickBox()
	};

	sprite.moveToTop();
	box.watcher = watchEvent(runtime, () => { box && renderPanel(true); });
	runtime.addEventListener("tick", box.onTick);
	runtime.addEventListener("beforeanylayoutend", destroyEventBox);

	renderPanel(true);
	placePanel();
}

// Call from "On end of layout". Takes the HTML panel off the page; without
// this it would sit over the next layout.
export function destroyEventBox() {
	if (!box) return;
	const { runtime, ui, watcher } = box;
	runtime.removeEventListener("tick", box.onTick);
	runtime.removeEventListener("beforeanylayoutend", destroyEventBox);
	watcher?.stop();
	ui.root.remove();
	box = null;
}

// On tap of MSpriteEventBoxBG, with where the tap landed on its layer
// (Touch.X / Touch.Y). Only the "^" tab toggles the panel.
export function tapEventBox(x, y) {
	if (!box || !onTab(x, y)) return;
	if (box.target === 1) closeEventBox();
	else openEventBox();
}

export function openEventBox() {
	if (!box) return;
	if (box.target !== 1) {
		closeDetailBox();                  // the two panels share the right-hand side
		box.opts.onOpen?.();
		box.watcher.refresh();             // show the latest as it slides up
	}
	box.target = 1;
}

export function closeEventBox() {
	if (!box) return;
	box.target = 0;
	box.confirmUntil = 0;
	if (box.ui.root.contains(document.activeElement)) document.activeElement.blur();
}

export function isEventBoxOpen() {
	return !!box && box.target === 1;
}

// True when `inst` sits behind the panel while it is up (or on its way up).
// Construct's "On tap object" fires for everything under the finger, so
// things drawn under the panel call this and ignore the tap.
export function isUnderEventBox(inst) {
	if (!box || box.progress === 0 || !inst) return false;
	const b = inst.getBoundingBox();
	const x = (b.left + b.right) / 2;
	const y = (b.top + b.bottom) / 2;
	const p = panelRect();
	return x >= p.left && x <= p.right && y >= p.top && y <= p.bottom;
}

// ---------------------------------------------------------------- panel: per tick

function tickBox() {
	if (!box) return;
	// Left the layout without "On end of layout" running: tidy up.
	if (box.runtime.layout !== box.layout) {
		destroyEventBox();
		return;
	}

	const move = box.runtime.dt / EVENTS.slideSeconds;
	if (box.progress < box.target) box.progress = Math.min(box.target, box.progress + move);
	else if (box.progress > box.target) box.progress = Math.max(box.target, box.progress - move);

	placePanel();
	renderPanel(false);
}

function placePanel() {
	const { sprite, ui } = box;
	sprite.y = box.closedY + (box.openY - box.closedY) * easeInOutCubic(box.progress);

	const p = panelRect();
	const layer = sprite.layer;
	const [x1, y1] = layer.layerToCssPx(p.left, p.top);
	const [x2]     = layer.layerToCssPx(p.right, p.bottom);
	const [, canvasBottom] = layer.layerToCssPx(0, box.layout.height);

	const designW = EVENTS.image.width;
	const designH = EVENTS.image.height - EVENTS.panelTop;
	const scale = (x2 - x1) / designW;
	// Whatever has slid past the bottom of the canvas is cut off, so the
	// panel never pokes out below the game area.
	const hidden = Math.max(0, (y1 + designH * scale - canvasBottom) / Math.max(scale, 0.0001));
	const shown = box.progress > 0;

	const key = [x1, y1, scale, hidden, shown].map(n => Math.round(Number(n) * 100)).join();
	if (key === box.styleKey) return;
	box.styleKey = key;

	Object.assign(ui.root.style, {
		left: x1 + "px",
		top: y1 + "px",
		width: designW + "px",
		height: designH + "px",
		transform: `scale(${scale})`,
		clipPath: `inset(0 0 ${hidden}px 0)`,
		display: shown ? "flex" : "none"
	});
}

// Rewrites whatever has changed. `full` also resets the form state (after
// an event starts or stops); otherwise only the countdown and the cancel
// confirmation move on.
function renderPanel(full) {
	const { ui, watcher } = box;
	const event = watcher.current();
	const running = !!event;
	const now = performance.now();
	const confirming = running && box.confirmUntil > now;
	if (box.confirmUntil && !confirming) box.confirmUntil = 0;

	const key = [running, event?.event_id, running ? Math.ceil(watcher.secondsLeft()) : 0, confirming, box.busy].join();
	if (!full && key === box.shownKey) return;
	box.shownKey = key;

	if (running) {
		setText(ui.statusDot, "●  LIVE");
		ui.statusDot.style.color = COLORS.live;
		setText(ui.statusName, event.name);
		setText(ui.statusInfo,
			`${formatTime(watcher.secondsLeft())} left` +
			(event.started_by_name ? `  ·  started by ${event.started_by_name}` : ""));
	} else {
		setText(ui.statusDot, "No event running");
		ui.statusDot.style.color = COLORS.dim;
		setText(ui.statusName, "");
		setText(ui.statusInfo, "Fill in the details below and press Start.");
	}

	// One event at a time: the form is for the next event, so it is locked
	// while one is running and Cancel takes Start's place.
	const locked = running || box.busy;
	ui.name.disabled = locked;
	ui.minutes.disabled = locked;
	for (const b of ui.presets) b.disabled = locked;
	ui.form.style.opacity = running ? "0.45" : "1";

	ui.start.style.display = running ? "none" : "block";
	ui.start.disabled = box.busy;
	setText(ui.start, box.busy && !running ? "Starting..." : "Start Event");

	ui.cancel.style.display = running ? "block" : "none";
	ui.cancel.disabled = box.busy;
	setText(ui.cancel, box.busy && running ? "Cancelling..." : confirming ? "Tap again to cancel" : "Cancel Event");
	ui.cancel.style.background = confirming ? "#d9534f" : COLORS.cancel;

	if (full) highlightPreset();
}

// ---------------------------------------------------------------- panel: actions

async function startFromPanel() {
	if (!box || box.busy || box.watcher.current()) return;
	const { ui } = box;

	const name = ui.name.value.trim().replace(/\s+/g, " ");
	const minutes = Number(ui.minutes.value);
	if (!name) return showMessage("Give the event a name.", true, ui.name);
	if (name.length > EVENTS.maxNameLength) return showMessage(`Names can be at most ${EVENTS.maxNameLength} characters.`, true, ui.name);
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > EVENTS.maxMinutes)
		return showMessage(`Duration must be a whole number of minutes, 1 to ${EVENTS.maxMinutes}.`, true, ui.minutes);

	box.busy = true;
	showMessage("");
	renderPanel(true);
	try {
		const event = await api.startEvent(name, minutes);
		if (!box) return;
		box.watcher.set(event);
		ui.name.value = "";
		showMessage(`"${name}" is live for ${minutes} minute${minutes === 1 ? "" : "s"}.`);
	} catch (err) {
		console.error("[events] starting the event failed:", err);
		showMessage("Couldn't start the event: " + (err?.message ?? err), true);
	} finally {
		if (box) {
			box.busy = false;
			renderPanel(true);
		}
	}
}

async function cancelFromPanel() {
	if (!box || box.busy) return;
	const event = box.watcher.current();
	if (!event) return;

	// First tap arms it, second tap within a few seconds cancels.
	if (!(box.confirmUntil > performance.now())) {
		box.confirmUntil = performance.now() + EVENTS.confirmSeconds * 1000;
		renderPanel(true);
		return;
	}

	box.busy = true;
	box.confirmUntil = 0;
	showMessage("");
	renderPanel(true);
	try {
		await api.cancelEvent(event.event_id);
		if (!box) return;
		box.watcher.set(null);
		showMessage(`"${event.name}" was cancelled.`);
		box.watcher.refresh();          // in case someone else had already started another
	} catch (err) {
		console.error("[events] cancelling the event failed:", err);
		showMessage("Couldn't cancel the event: " + (err?.message ?? err), true);
	} finally {
		if (box) {
			box.busy = false;
			renderPanel(true);
		}
	}
}

function showMessage(text, isError = false, focus = null) {
	if (!box) return;
	setText(box.ui.message, text);
	box.ui.message.style.color = isError ? COLORS.error : COLORS.dim;
	if (focus) focus.focus();
}

function highlightPreset() {
	const value = Number(box.ui.minutes.value);
	for (const b of box.ui.presets) {
		const on = Number(b.dataset.minutes) === value;
		b.style.background = on ? "#7a7a7a" : COLORS.preset;
		b.style.borderColor = on ? "#bdbdbd" : COLORS.border;
	}
}

// ---------------------------------------------------------------- panel: HTML

function buildPanel() {
	const root = el("div", {
		position: "fixed",
		zIndex: "10",
		display: "none",
		flexDirection: "column",
		gap: "14px",
		boxSizing: "border-box",
		padding: "30px 40px",
		transformOrigin: "0 0",
		fontFamily: "Arial, sans-serif",
		color: COLORS.text,
		userSelect: "none"
	});
	root.className = "c3-event-box";

	// Taps on the panel are for the panel: don't let them reach the canvas
	// and the checkboxes drawn underneath.
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "wheel", "click"])
		root.addEventListener(type, e => e.stopPropagation());

	const title = el("div", { fontSize: "34px", fontWeight: "bold" }, "Event");

	const status = el("div", {
		background: "#3a3a3a",
		border: `2px solid ${COLORS.border}`,
		borderRadius: "8px",
		padding: "14px 18px",
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		height: "118px",
		boxSizing: "border-box",
		justifyContent: "center"
	});
	const statusDot  = el("div", { fontSize: "18px", fontWeight: "bold", letterSpacing: "1px" });
	const statusName = el("div", { fontSize: "28px", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
	const statusInfo = el("div", { fontSize: "19px", color: COLORS.dim });
	status.append(statusDot, statusName, statusInfo);

	const form = el("div", { display: "flex", flexDirection: "column", gap: "8px" });

	const name = input("text", { placeholder: "e.g. Gartic Phone", maxLength: EVENTS.maxNameLength });
	name.setAttribute("aria-label", "Event name");

	const minutes = input("number", { min: 1, max: EVENTS.maxMinutes, step: 1, value: EVENTS.defaultMinutes });
	minutes.setAttribute("aria-label", "Duration in minutes");
	minutes.style.width = "160px";

	const presets = EVENTS.presets.map(m => {
		const b = button(`${m}`, COLORS.preset, { width: "80px", height: "56px", fontSize: "22px", border: `2px solid ${COLORS.border}` });
		b.dataset.minutes = m;
		b.addEventListener("click", () => {
			minutes.value = m;
			highlightPreset();
		});
		return b;
	});
	minutes.addEventListener("input", () => highlightPreset());

	const durationRow = el("div", { display: "flex", gap: "10px", alignItems: "center" });
	durationRow.append(minutes, el("span", { fontSize: "20px", color: COLORS.dim, marginRight: "6px" }, "min"), ...presets);

	form.append(
		label("Event name"), name,
		el("div", { height: "6px" }),
		label("Duration (minutes)"), durationRow
	);

	const start  = button("Start Event",  COLORS.start,  { width: "100%", height: "66px", fontSize: "26px", fontWeight: "bold" });
	const cancel = button("Cancel Event", COLORS.cancel, { width: "100%", height: "66px", fontSize: "26px", fontWeight: "bold" });
	start.addEventListener("click", () => startFromPanel());
	cancel.addEventListener("click", () => cancelFromPanel());

	const message = el("div", { fontSize: "19px", minHeight: "24px", color: COLORS.dim });

	root.append(title, status, form, el("div", { flex: "1" }), start, cancel, message);

	// Enter starts, Escape puts the panel away.
	root.addEventListener("keydown", e => {
		e.stopPropagation();
		if (e.key === "Enter" && (e.target === name || e.target === minutes)) startFromPanel();
		if (e.key === "Escape") closeEventBox();
	});

	document.body.appendChild(root);
	return { root, statusDot, statusName, statusInfo, form, name, minutes, presets, start, cancel, message };
}

function el(tag, style = {}, text = "") {
	const e = document.createElement(tag);
	Object.assign(e.style, style);
	if (text) e.textContent = text;
	return e;
}

function label(text) {
	return el("div", { fontSize: "20px", color: COLORS.dim }, text);
}

function input(type, props) {
	const e = el("input", {
		boxSizing: "border-box",
		height: "56px",
		width: "100%",
		padding: "0 14px",
		fontSize: "24px",
		fontFamily: "inherit",
		color: COLORS.text,
		background: COLORS.field,
		border: `2px solid ${COLORS.border}`,
		borderRadius: "6px",
		outline: "none",
		userSelect: "text"
	});
	e.type = type;
	e.autocomplete = "off";
	e.spellcheck = false;
	Object.assign(e, props);
	return e;
}

function button(text, background, style = {}) {
	const b = el("button", {
		boxSizing: "border-box",
		border: "none",
		borderRadius: "8px",
		color: "#fff",
		background,
		fontFamily: "inherit",
		cursor: "pointer",
		...style
	}, text);
	b.type = "button";
	return b;
}

function setText(e, text) {
	if (e.textContent !== text) e.textContent = text;
}

// ---------------------------------------------------------------- panel: geometry

function scaleOf() {
	const r = box.sprite.getBoundingBox();
	return { r, sx: r.width / EVENTS.image.width, sy: r.height / EVENTS.image.height };
}

// The panel part of the sprite (below the tab row), in layout coordinates.
function panelRect() {
	const { r, sy } = scaleOf();
	return { left: r.left, top: r.top + EVENTS.panelTop * sy, right: r.right, bottom: r.bottom };
}

function onTab(x, y) {
	if (typeof x !== "number" || typeof y !== "number") return true;
	const { r, sx, sy } = scaleOf();
	return x >= r.left + EVENTS.tab.left * sx && x <= r.right &&
	       y >= r.top && y <= r.top + EVENTS.tab.bottom * sy;
}

// ================================================================ student banner

let banner = null;
// { runtime, layout, sprites, texts, watcher, fade, shownKey, onTick }

// Call once from the student layout's "On start of layout".
//   sprite  name of the banner sprite (default "SSpriteEvent")
//   text    name of the Text that gets the event name (default "STextEventInfo")
export function initStudentEvent(runtime, opts = {}) {
	stopStudentEvent();

	const sprites = runtime.objects[opts.sprite ?? "SSpriteEvent"]?.getAllInstances() ?? [];
	const texts   = runtime.objects[opts.text ?? "STextEventInfo"]?.getAllInstances() ?? [];
	if (!sprites.length && !texts.length) {
		console.error("[events] there is no SSpriteEvent or STextEventInfo on this layout");
		return;
	}

	banner = {
		runtime, sprites, texts,
		layout: runtime.layout,
		opacity: new Map([...sprites, ...texts].map(i => [i, i.opacity])),
		fade: 0,
		shownKey: "",
		watcher: null,
		onTick: () => tickBanner()
	};
	showBanner(false);

	banner.watcher = watchEvent(runtime, () => { banner && tickBanner(); });
	runtime.addEventListener("tick", banner.onTick);
	runtime.addEventListener("beforeanylayoutend", stopStudentEvent);
}

export function stopStudentEvent() {
	if (!banner) return;
	banner.runtime.removeEventListener("tick", banner.onTick);
	banner.runtime.removeEventListener("beforeanylayoutend", stopStudentEvent);
	banner.watcher?.stop();
	banner = null;
}

function tickBanner() {
	if (!banner) return;
	if (banner.runtime.layout !== banner.layout) {
		stopStudentEvent();
		return;
	}

	const { watcher } = banner;
	const event = isWeekendLocked() ? null : watcher.current();

	if (!event) {
		if (banner.fade > 0 || banner.shownKey) {
			banner.fade = 0;
			banner.shownKey = "";
			showBanner(false);
		}
		return;
	}

	const timeLeft = formatTime(watcher.secondsLeft());
	const key = event.event_id + "|" + timeLeft;
	if (key !== banner.shownKey) {
		banner.shownKey = key;
		const text = EVENTS.studentText(safeBBCode(event.name), timeLeft);
		for (const t of banner.texts) t.text = text;
	}

	if (banner.fade < 1) {
		banner.fade = Math.min(1, banner.fade + banner.runtime.dt / EVENTS.fadeSeconds);
		showBanner(true, banner.fade);
	}
}

function showBanner(visible, amount = 1) {
	for (const inst of [...banner.sprites, ...banner.texts]) {
		try {
			inst.isVisible = visible;
			inst.opacity = (banner.opacity.get(inst) ?? 1) * amount;
		} catch { /* destroyed */ }
	}
}

// ================================================================ helpers

// 125 -> "2:05", 3725 -> "1:02:05"
function formatTime(seconds) {
	const s = Math.max(0, Math.ceil(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const ss = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Construct's BBCode has no escape, so brackets in a name become parentheses.
function safeBBCode(text) {
	return String(text ?? "").replace(/\[/g, "(").replace(/\]/g, ")");
}

function originY(inst) {
	const r = inst.getBoundingBox();
	return r.height ? (inst.y - r.top) / r.height : 0.5;
}

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
