// identity.js
// Puts the signed-in user's Discord picture and username on the student view.
//
//   SSpriteAvatar     -> replaced with the user's Discord avatar
//   STextStudentName  -> set to the user's Discord username
//
// Call loadStudentIdentity(runtime) from "On start of layout" on the
// StudentLayout. It does not block anything else: the checklist and totals
// keep loading while the picture downloads.
//
// The name and picture come from the Supabase session (Discord fills them in
// when the user signs in), so this needs no extra database call. In mock mode
// the mock user's display_name is used and the avatar is left as it is.

import { api } from "./data.js";

// ================================================================ tweak me
const AVATAR = "SSpriteAvatar";
const NAME   = "STextStudentName";
const AVATAR_SIZE = 256;         // px requested from Discord's CDN (16-4096, power of 2)
// ========================================================================

// The avatar picture is cached per URL so going back to the student view
// (e.g. after the 10:01 soft refresh) doesn't download it again.
let cachedUrl = null;
let cachedBlob = null;

export async function loadStudentIdentity(runtime) {
	let who;
	try {
		who = await api.getDiscordIdentity();
	} catch (err) {
		console.warn("[identity] could not read the Discord profile:", err);
		return;
	}
	if (!who) return;

	// The layout may have changed while we were waiting.
	if (runtime.layout.name !== "StudentLayout") return;

	const nameText = runtime.objects[NAME]?.getFirstInstance();
	if (nameText && who.username) nameText.text = who.username;

	if (who.avatarUrl) await setAvatar(runtime, who.avatarUrl);
}

async function setAvatar(runtime, url) {
	url = sized(url);
	try {
		if (url !== cachedUrl) {
			const res = await fetch(url, { mode: "cors" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			cachedBlob = await res.blob();
			cachedUrl = url;
		}

		const sprite = runtime.objects[AVATAR]?.getFirstInstance();
		if (!sprite || runtime.layout.name !== "StudentLayout") return;

		// Keep the size and position the avatar has in the layout editor,
		// whatever size the Discord picture is.
		const { width, height } = sprite;
		await sprite.replaceCurrentAnimationFrame(cachedBlob);
		sprite.width = width;
		sprite.height = height;
	} catch (err) {
		// Leave the placeholder picture in place.
		console.warn("[identity] could not load the Discord avatar:", err);
	}
}

// Ask Discord's CDN for a sensible size instead of the default 128px.
function sized(url) {
	try {
		const u = new URL(url);
		if (u.hostname.endsWith("discordapp.com") || u.hostname.endsWith("discord.com")) {
			u.searchParams.set("size", String(AVATAR_SIZE));
		}
		return u.toString();
	} catch { return url; }
}
