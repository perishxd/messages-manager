/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { PluginNative } from "@utils/types";
export async function downloadDesktopMedia(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const native = typeof VencordNative !== "undefined" ? VencordNative.pluginHelpers?.MessagesManager as PluginNative<typeof import("./native")> | undefined : undefined;
    if (!native?.downloadMedia) throw Error("Browser blocked this download. Desktop media support is unavailable; rebuild Vencord and fully restart Discord.");
    const id = crypto.randomUUID();
    const abort = () => { void native.cancelMedia(id).catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        const result = await native.downloadMedia(url, maxBytes, id);
        signal.throwIfAborted();
        if (!result.ok) throw Error(`Desktop download: ${result.error}`);
        const bytes = new Uint8Array(result.bytes);
        if (bytes.byteLength > maxBytes) throw Error("File exceeds the archive size limit.");
        return bytes;
    } finally { signal.removeEventListener("abort", abort); }
}
