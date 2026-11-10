/* SPDX-License-Identifier: GPL-3.0-or-later */
import { strToU8, zipSync } from "fflate";
import type { ScanResult } from "./core";
import { escapeHtml, renderExport, safeUrl, Theme } from "./export";
import { allowedMediaUrl } from "./mediaPolicy";

const MiB = 1024 * 1024;
export const archiveLimits = { file: 25 * MiB, total: 100 * MiB, files: 2000 };
interface Hooks { signal: AbortSignal; checkpoint(): Promise<void>; progress(phase: string): void; fallback?(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>; }
interface Limits { file: number; total: number; files: number; }
interface Missed { conversation: string; conversationName: string; filename: string; url: string; reason: string; }
const unescapeUrl = (url: string) => url.replace(/&amp;/g, "&");
const fileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file";
const folderName = (id: string, name: string) => `dm-${id}-${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 45) || "conversation"}`;
const isAvatar = (url: URL) => /^\/(?:embed\/)?avatars\//.test(url.pathname);

async function readAsset(url: string, hooks: Hooks, fetcher: typeof fetch, limit: number): Promise<Uint8Array> {
    const timeout = new AbortController();
    const abort = () => timeout.abort(hooks.signal.reason);
    hooks.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => timeout.abort(Error("Download timed out.")), 30000);
    try {
        await hooks.checkpoint();
        const response = await fetcher(url, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: timeout.signal });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        if (Number(response.headers.get("content-length")) > limit) {
            await response.body?.cancel(); throw Error("File exceeds the archive size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw Error("The server returned no file data.");
        const parts: Uint8Array[] = []; let size = 0;
        try {
            while (true) {
                await hooks.checkpoint();
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) throw Error("File exceeds the archive size limit.");
                parts.push(value);
            }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        return bytes;
    } finally { clearTimeout(timer); hooks.signal.removeEventListener("abort", abort); }
}

/** Produces local pages and assets without changing the original message archive. */
export async function buildArchive(plan: ScanResult, theme: Theme, hooks: Hooks, fetcher: typeof fetch = fetch, limits: Limits = archiveLimits) {
    const generated = new Date().toISOString();
    const files: Record<string, Uint8Array> = { "avatars/": new Uint8Array(), "conversations/": new Uint8Array() };
    const cached = new Map<string, { bytes?: Uint8Array; reason?: string; avatarPath?: string }>();
    const savedUrls = new Set<string>();
    const missed: Missed[] = [], pages: { name: string; path: string; count: number }[] = [];
    let total = 0, storedBytes = 0, downloaded = 0, attempted = 0;
    for (const channel of plan.channels) {
        await hooks.checkpoint();
        const folder = `conversations/${folderName(channel.id, channel.name)}`;
        const messages = plan.messages.filter(message => message.channel_id === channel.id);
        const page = renderExport({ ...plan, channels: [channel], messages }, theme, generated);
        // Only generated URL attributes are replaced; text and embedded links stay escaped.
        const urls = new Set([...page.matchAll(/(?:src|href)="(https:[^"]+)"/g)].map(match => unescapeUrl(match[1])));
        const local = new Map<string, string>(); let mediaNumber = 0;
        for (const url of urls) {
            await hooks.checkpoint();
            const parsed = new URL(url);
            // Never crawl websites or send Discord credentials while copying files.
            if (!safeUrl(url) || !allowedMediaUrl(url)) continue;
            let asset = cached.get(url);
            if (!asset) {
                hooks.progress(`Saving media… ${downloaded} files · ${(total / MiB).toFixed(1)} MB`);
                if (attempted >= limits.files) asset = { reason: `Archive limited to ${limits.files} media downloads.` };
                else if (total >= limits.total) asset = { reason: "Archive media size limit reached." };
                else {
                    attempted++;
                    try {
                        const limit = Math.min(limits.file, limits.total - total);
                        let bytes: Uint8Array;
                        try { bytes = await readAsset(url, hooks, fetcher, limit); }
                        catch (error) {
                            await hooks.checkpoint();
                            if (!(error instanceof TypeError || error instanceof Error && error.name === "NetworkError")) throw error;
                            if (!hooks.fallback) throw Error("Browser could not read this file (network/CORS restriction).");
                            hooks.progress(`Downloading through desktop… ${downloaded} files saved`);
                            bytes = await hooks.fallback(url, limit, hooks.signal);
                            await hooks.checkpoint();
                            if (bytes.byteLength > limit) throw Error("File exceeds the archive size limit.");
                        }
                        total += bytes.byteLength; asset = { bytes };
                    } catch (error) {
                        // Cancellation, pausing, and account changes belong to the job, not a partial archive.
                        await hooks.checkpoint();
                        asset = { reason: error instanceof Error ? error.message : "Download failed." };
                    }
                }
                cached.set(url, asset);
            }
            const missing = (reason: string) => missed.push({ conversation: channel.id, conversationName: channel.name, filename: parsed.pathname.split("/").pop() ?? "file", url, reason });
            if (!asset.bytes) { missing(asset.reason ?? "Unavailable file."); continue; }
            const name = fileName(parsed.pathname.split("/").pop() ?? "file");
            if ((!isAvatar(parsed) || !asset.avatarPath) && storedBytes + asset.bytes.byteLength > limits.total) {
                missing("Archive stored media size limit reached."); continue;
            }
            if (isAvatar(parsed)) {
                if (!asset.avatarPath) {
                    asset.avatarPath = `avatars/${String(Object.keys(files).length).padStart(5, "0")}_${name}`;
                    files[asset.avatarPath] = asset.bytes;
                    storedBytes += asset.bytes.byteLength;
                }
                local.set(escapeHtml(url), `../../${asset.avatarPath}`);
            } else {
                const path = `media/${String(++mediaNumber).padStart(5, "0")}_${name}`;
                files[`${folder}/${path}`] = asset.bytes;
                storedBytes += asset.bytes.byteLength;
                local.set(escapeHtml(url), path);
            }
            if (!savedUrls.has(url)) { savedUrls.add(url); downloaded++; }
        }
        let html = page.replace(/(src|href)="(https:[^"]+)"/g, (all, attr, url) => local.has(url) ? `${attr}="${local.get(url)}"` : all);
        html = html.replace("img-src https: data:", "img-src 'self' file: https: data:").replace("media-src https:", "media-src 'self' file: https:")
            .replace("Remote media may expire.", "Media is saved alongside this page. Unsaved files keep their original links.")
            .replace('<nav><strong>', '<nav><a href="../../index.html">All conversations</a><strong>');
        const missingHere = missed.filter(file => file.conversation === channel.id).length;
        if (missingHere) html = html.replace("<main>", `<main><aside>${missingHere} files could not be saved offline. <a href="../../media-report.html">View download report</a>.</aside>`);
        files[`${folder}/index.html`] = strToU8(html);
        pages.push({ name: channel.name, path: `${folder}/index.html`, count: messages.length });
        // Allow Discord to render progress between conversations.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    await hooks.checkpoint();
    const base = renderExport({ ...plan, messages: [] }, theme, generated);
    const style = base.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const reportPage = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>${style}</style></head><body><main>${body}</main></body></html>`;
    files["index.html"] = strToU8(reportPage("MessagesManager archive", `<h1>MessagesManager export</h1><p>Extract the whole ZIP and keep both folders beside this page.</p><p>${downloaded} media files saved. ${missed.length} files could not be saved. <a href="media-report.html">View download report</a>.</p>${pages.map(page => `<p><a href="${page.path}">${escapeHtml(page.name)}</a> · ${page.count} messages</p>`).join("")}`));
    files["media-report.html"] = strToU8(reportPage("Media download report", `<a href="index.html">All conversations</a><h1>Media download report</h1><p>${downloaded} files saved; ${missed.length} unavailable file references. Limits: 25 MB per file, 100 MB total. HTTP 404 means the server could not find the file; HTTP 403 means access was denied.</p>${missed.length ? missed.map(file => `<aside><strong>${escapeHtml(file.filename)}</strong><p>${escapeHtml(file.conversationName)} · ${escapeHtml(file.reason)}</p><a href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">Try original link</a></aside>`).join("") : "<p>All supported media was saved successfully.</p>"}`));
    files["media-report.json"] = strToU8(JSON.stringify({ exportedAt: generated, downloaded, bytes: total, storedBytes, limits, unavailable: missed }, null, 2));
    files["README.txt"] = strToU8("Extract all files, then open index.html.\nKeep avatars/ and conversations/ beside index.html. Each conversation contains its own page and media/ folder.\nDownloaded images, videos, attachments, emoji, stickers, and guild-tag images use local paths. Unsaved files keep online links; check media-report.json.\nMedia limits: 25 MB per file, 100 MB total, 2000 downloads. Narrow the date range for larger exports.\nFonts aren't bundled. External websites in messages are not downloaded.\n");
    hooks.progress("Packing ZIP archive…");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await hooks.checkpoint();
    // Media is already compressed. Store entries to avoid blocking Discord with recompression.
    const bytes = zipSync(files, { level: 0 });
    await hooks.checkpoint();
    return { bytes, downloaded, missed: missed.length };
}
