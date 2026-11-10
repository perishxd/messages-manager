/* SPDX-License-Identifier: GPL-3.0-or-later */
export const maxMediaFileBytes = 25 * 1024 * 1024;
const hosts = new Set(["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"]);
export function allowedMediaUrl(value: string) {
    try {
        const url = new URL(value);
        return value.length <= 8192 && url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.has(url.hostname);
    } catch { return false; }
}
