/* SPDX-License-Identifier: GPL-3.0-or-later */
import { IpcMainInvokeEvent, net } from "electron";
import { allowedMediaUrl, maxMediaFileBytes } from "./mediaPolicy";

const requests = new Map<string, AbortController>();
const validId = (id: string) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
export async function downloadMedia(event: IpcMainInvokeEvent, url: string, maxBytes: number, id: string) {
    if (!validId(id) || !allowedMediaUrl(url) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maxMediaFileBytes)
        return { ok: false as const, error: "Invalid media download request." };
    const key = `${event.sender.id}:${id}`;
    if (requests.has(key) || requests.size >= 4) return { ok: false as const, error: "Too many media downloads." };
    const controller = new AbortController(); requests.set(key, controller);
    const timer = setTimeout(() => controller.abort(Error("Media download timed out.")), 30000);
    try {
        // Use Electron's network stack without cookies, tokens, or cross-host redirects.
        const response = await net.fetch(url, { credentials: "omit", redirect: "error", signal: controller.signal,
            headers: { "User-Agent": event.sender.getUserAgent() } });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw Error("File exceeds the archive size limit."); }
        const reader = response.body?.getReader(); if (!reader) throw Error("The server returned no file data.");
        const parts: Uint8Array[] = []; let size = 0;
        try {
            while (true) {
                controller.signal.throwIfAborted();
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength; if (size > maxBytes) throw Error("File exceeds the archive size limit.");
                parts.push(value);
            }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        controller.signal.throwIfAborted();
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        return { ok: true as const, bytes };
    } catch (error) {
        return { ok: false as const, error: controller.signal.aborted ? "Media download cancelled or timed out." : error instanceof Error ? error.message : "Media download failed." };
    } finally { clearTimeout(timer); requests.delete(key); }
}
export async function cancelMedia(event: IpcMainInvokeEvent, id: string) {
    if (validId(id)) requests.get(`${event.sender.id}:${id}`)?.abort(Error("Cancelled."));
}
