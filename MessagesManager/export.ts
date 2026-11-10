/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { Author, Message, ScanResult } from "./core";
export interface Theme { background: string; surface: string; text: string; muted: string; heading: string; link: string; accent: string; font: string; size: string; lineHeight: string; messageSpacing: string; avatarRadius: string; }
export const defaultTheme: Theme = { background: "#313338", surface: "#2b2d31", text: "#dbdee1", muted: "#949ba4", heading: "#f2f3f5", link: "#00a8fc", accent: "#5865f2", font: '"gg sans", "Segoe UI", sans-serif', size: "16px", lineHeight: "1.45", messageSpacing: "18px", avatarRadius: "50%" };
export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function safeUrl(value: unknown): string {
    if (typeof value !== "string") return "";
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; }
}
export function guildTag(author: Author) {
    const guild = author.primary_guild;
    if (guild?.identity_enabled !== true || !guild.tag) return "";
    const badge = /^\d{17,20}$/.test(guild.identity_guild_id ?? "") && /^[a-f0-9]{32}$/i.test(guild.badge ?? "")
        ? `https://cdn.discordapp.com/clan-badges/${guild.identity_guild_id}/${guild.badge}.png?size=32` : "";
    return `<span class="guild-tag" title="Server tag at export time">${badge ? `<img src="${badge}" alt="" loading="lazy">` : ""}${escapeHtml(guild.tag)}</span>`;
}
export function captureTheme(): Theme {
    const root = getComputedStyle(document.documentElement);
    const sample = document.querySelector('[class*="messageContent_"]') ?? document.querySelector('[class*="chatContent_"]') ?? document.body;
    const content = getComputedStyle(sample);
    const message = sample.closest('[id^="chat-messages-"]');
    const avatarElement = message?.querySelector('[class*="avatar_"]');
    const variable = (names: string[], fallback: string) => {
        // Theme variables often reference other variables; export their resolved color.
        const name = names.find(name => content.getPropertyValue(name).trim() || root.getPropertyValue(name).trim());
        if (!name) return fallback;
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
        probe.style.color = `var(${name}, ${fallback})`;
        sample.appendChild(probe);
        try { return getComputedStyle(probe).color || fallback; }
        finally { probe.remove(); }
    };
    return { background: variable(["--background-primary", "--background-base-lowest"], defaultTheme.background), surface: variable(["--background-secondary", "--background-base-low"], defaultTheme.surface),
        text: content.color || variable(["--text-normal", "--text-default"], defaultTheme.text), muted: variable(["--text-muted", "--text-subtle"], defaultTheme.muted),
        heading: variable(["--header-primary", "--text-strong"], defaultTheme.heading), link: variable(["--text-link"], defaultTheme.link), accent: variable(["--brand-500"], defaultTheme.accent),
        font: content.fontFamily || defaultTheme.font, size: content.fontSize || defaultTheme.size, lineHeight: content.lineHeight === "normal" ? defaultTheme.lineHeight : content.lineHeight,
        messageSpacing: message && parseFloat(getComputedStyle(message).marginTop) > 0 ? getComputedStyle(message).marginTop : defaultTheme.messageSpacing,
        avatarRadius: avatarElement ? getComputedStyle(avatarElement).borderRadius : defaultTheme.avatarRadius };
}
function css(value: unknown) { return String(value ?? "").replace(/[<>{};\r\n]/g, ""); }
function avatar(author: Author) {
    if (/^\d{17,20}$/.test(author.id) && /^[a-f0-9_]+$/i.test(author.avatar ?? ""))
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${author.avatar?.startsWith("a_") ? "gif" : "png"}?size=80`;
    let index = 0; try { index = Number((BigInt(author.id) >> 22n) % 6n); } catch { /* deleted users */ }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
function format(text: string, users: Map<string, string>) {
    return String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/g).map(part => {
        if (part.startsWith("```")) return `<pre><code>${escapeHtml(part.slice(3, -3).replace(/^[a-z]+\n/i, ""))}</code></pre>`;
        if (part.startsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        const inline = (value: string) => escapeHtml(value)
            .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${escapeHtml(users.get(id) ?? id)}</span>`)
            .replace(/&lt;(a?):(\w+):(\d{17,20})&gt;/g, (_, animated, name, id) => `<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=48" alt=":${name}:" loading="lazy">`)
            .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<u>$1</u>")
            .replace(/~~([^~\n]+)~~/g, "<del>$1</del>").replace(/\|\|([^|]+)\|\|/g, '<span class="spoiler" tabindex="0">$1</span>')
            .replace(/\n/g, "<br>");
        return part.split(/(\[[^\]\n]{1,200}\]\(https:\/\/[^\s<>]+\)|https:\/\/[^\s<>`]+)/g).map(piece => {
            const markdown = piece.match(/^\[([^\]]+)\]\((https:\/\/.+)\)$/);
            if (markdown) {
                const url = safeUrl(markdown[2]);
                return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(markdown[1])}</a>` : inline(piece);
            }
            if (!piece.startsWith("https://")) return inline(piece);
            let url = piece, tail = "";
            while (/[.,!?;:]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
            for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]])
                while (url.endsWith(close) && url.split(close).length > url.split(open).length) { tail = close + tail; url = url.slice(0, -1); }
            const safe = safeUrl(url);
            return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${inline(tail)}` : inline(piece);
        }).join("");
    }).join("");
}
function attachment(item: NonNullable<Message["attachments"]>[number]) {
    const url = safeUrl(item.url); if (!url) return `<div class="attachment">${escapeHtml(item.filename)} — unavailable link</div>`;
    const link = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" download>${escapeHtml(item.filename)}</a>`;
    return `<div class="attachment">${item.content_type?.startsWith("image/") ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img class="media" src="${escapeHtml(url)}" alt="${escapeHtml(item.filename)}" loading="lazy"></a>` : item.content_type?.startsWith("video/") ? `<video class="media" controls preload="none" src="${escapeHtml(url)}"></video>` : item.content_type?.startsWith("audio/") ? `<audio class="media" controls preload="none" src="${escapeHtml(url)}"></audio>` : ""}${link}${typeof item.size === "number" && item.size >= 0 ? `<small class="subtle">${item.size < 1024 ? `${item.size} B` : item.size < 1048576 ? `${(item.size / 1024).toFixed(1)} KB` : `${(item.size / 1048576).toFixed(1)} MB`}</small>` : ""}</div>`;
}
export function renderExport(plan: ScanResult, theme: Theme, generated = new Date().toISOString()) {
    const users = new Map(plan.messages.map(m => [m.author.id, m.author.global_name || m.author.username || m.author.id]));
    const messageIds = new Set(plan.messages.map(message => message.id));
    const sections = plan.channels.map(channel => {
        const messages = plan.messages.filter(m => m.channel_id === channel.id).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        let lastDay = "";
        return `<section id="dm-${channel.id}"><h2>${escapeHtml(channel.name)}</h2><p class="subtle">${messages.length.toLocaleString()} messages · ${channel.id}</p>${messages.map(message => {
            const day = message.timestamp.slice(0, 10), separator = day !== lastDay ? `<div class="date">${escapeHtml(day)}</div>` : ""; lastDay = day;
            const reply = message.referenced_message;
            const replyHtml = reply ? `<div class="reply">↪ ${escapeHtml(reply.author?.global_name || reply.author?.username || "Reply")}: ${escapeHtml(reply.content.slice(0, 240))}${messageIds.has(reply.id) ? ` · <a href="#m-${reply.id}" title="Jump to referenced message">Jump to message</a>` : ""}</div>` : "";
            const embeds = (message.embeds ?? []).map(e => `<aside>${e.title ? `<strong>${escapeHtml(e.title)}</strong>` : ""}<div>${format(e.description ?? "", users)}</div>${safeUrl(e.url) ? `<a href="${escapeHtml(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">Open link</a>` : ""}</aside>`).join("");
            const stickers = (message.sticker_items ?? []).map(s => `<div class="attachment">Sticker: ${escapeHtml(s.name)}${/^\d{17,20}$/.test(s.id) && [1,2,4].includes(s.format_type) ? `<img class="sticker" src="https://cdn.discordapp.com/stickers/${s.id}.${s.format_type === 4 ? "gif" : "png"}" alt="${escapeHtml(s.name)}" loading="lazy">` : ""}</div>`).join("");
            return `${separator}<article id="m-${message.id}"><img class="avatar" src="${avatar(message.author)}" alt="" loading="lazy"><div class="body">${replyHtml}<header><strong>${escapeHtml(users.get(message.author.id))}</strong>${guildTag(message.author)}<time datetime="${escapeHtml(message.timestamp)}">${escapeHtml(message.timestamp.replace("T", " ").slice(0, 19))} UTC</time>${message.edited_timestamp ? '<small>(edited)</small>' : ""}</header>${message.type !== 0 && message.type !== 19 ? `<small class="subtle">System / special message · type ${message.type}</small>` : ""}<div class="content">${format(message.content, users)}</div>${(message.attachments ?? []).map(attachment).join("")}${embeds}${stickers}</div></article>`;
        }).join("")}</section>`;
    }).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src https: data:; script-src 'none'; base-uri 'none'; form-action 'none'"><title>MessagesManager export</title><style>
:root{--bg:${css(theme.background)};--surface:${css(theme.surface)};--text:${css(theme.text)};--muted:${css(theme.muted)};--heading:${css(theme.heading)};--link:${css(theme.link)};--accent:${css(theme.accent)};font-family:${css(theme.font)};--message-spacing:${css(theme.messageSpacing)};--avatar-radius:${css(theme.avatarRadius)};font-size:${css(theme.size)};line-height:${css(theme.lineHeight)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.layout{max-width:1200px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr)}nav{padding:28px 20px;background:var(--surface);position:sticky;top:0;height:100vh;overflow:auto}nav a{display:block;padding:8px 0;overflow-wrap:anywhere}main{padding:28px 32px}h1,h2,header strong{color:var(--heading)}h1{font-size:24px}h2{margin-top:38px}.subtle,time,small,.reply{color:var(--muted);font-size:12px}a{color:var(--link)}article{display:flex;gap:16px;margin:var(--message-spacing) 0}.avatar{width:40px;height:40px;border-radius:var(--avatar-radius)}.body{min-width:0;flex:1}header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}header strong{font-size:1rem}.content{overflow-wrap:anywhere;white-space:normal;margin-top:3px}.guild-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;border:1px solid var(--muted);border-radius:5px;padding:1px 5px;background:var(--surface)}.guild-tag img{width:14px;height:14px}.date{display:flex;align-items:center;gap:15px;color:var(--muted);font-size:12px;margin:30px 0 16px}.date:before,.date:after{content:"";height:1px;background:var(--muted);opacity:.25;flex:1}pre,code,aside,.attachment{background:var(--surface);border-radius:6px}code{font-family:monospace;padding:2px 4px}pre{padding:12px;overflow:auto}pre code{padding:0}aside{border-left:4px solid var(--accent);padding:12px;margin-top:8px}.attachment{padding:8px;margin-top:8px;max-width:550px}.attachment a{display:block}.media{max-width:100%;max-height:480px;display:block;border-radius:5px}.sticker{display:block;width:160px}.emoji{height:1.4em;width:1.4em;vertical-align:middle}.mention{background:var(--accent);color:var(--heading);border-radius:3px;padding:0 3px}.spoiler{background:var(--muted);color:transparent;border-radius:3px;cursor:pointer}.spoiler:hover,.spoiler:focus{background:var(--surface);color:var(--text)}.reply{border-left:2px solid var(--muted);padding-left:8px;margin-bottom:5px}@media(max-width:720px){.layout{display:block}nav{height:auto;position:relative}main{padding:18px}.avatar{width:32px;height:32px}article{gap:10px}}@media print{nav{display:none}.layout{display:block}.spoiler{color:inherit}}
</style></head><body><div class="layout"><nav><strong>MessagesManager</strong>${plan.channels.map(c => `<a href="#dm-${c.id}">${escapeHtml(c.name)}</a>`).join("")}</nav><main><h1>Messages</h1><p class="subtle">Exported ${escapeHtml(generated)} · Account ${plan.owner}<br>Theme captured at export time. Guild tags reflect available user data, not historical membership. Remote media may expire.</p>${sections}</main></div></body></html>`;
}
