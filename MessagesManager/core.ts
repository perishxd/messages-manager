/* SPDX-License-Identifier: GPL-3.0-or-later */
export interface Author {
    id: string; username?: string; global_name?: string | null; avatar?: string | null;
    primary_guild?: { identity_guild_id?: string | null; identity_enabled?: boolean | null; tag?: string | null; badge?: string | null; } | null;
}
export interface Message {
    id: string; channel_id: string; author: Author; content: string; timestamp: string; type: number;
    edited_timestamp?: string | null;
    attachments?: { id: string; filename: string; url: string; content_type?: string; size?: number; }[];
    embeds?: { title?: string; description?: string; url?: string; }[];
    referenced_message?: { id: string; content: string; author?: Author; } | null;
    sticker_items?: { id: string; name: string; format_type: number; }[];
}
export interface Conversation { id: string; name: string; guildId?: string; }
export interface Range { after?: number; before: number; }
export interface TextFilter { text: string; mode: "exact" | "contains"; }
export const matchesText = (content: string, filter?: TextFilter) => {
    const text = filter?.text.trim().toLowerCase();
    return !text || (filter?.mode === "exact" ? content.toLowerCase() === text : content.toLowerCase().includes(text));
};
export interface ScanResult { owner: string; channels: Conversation[]; range: Range; messages: Message[]; scanned: number; ownCount: number; filter?: TextFilter; }
export interface Progress { phase: string; scanned: number; matched: number; deleted: number; missing: number; skipped?: number; total: number; channel: string; paused: boolean; }
export interface Transport {
    owner(): string | undefined;
    privateChannel(id: string): boolean;
    validateChannel?(channel: Conversation): Promise<void>;
    page(channel: string, before: string): Promise<unknown>;
    message(channel: string, id: string): Promise<unknown>;
    remove(channel: string, id: string): Promise<void>;
}
export const validId = (id: unknown): id is string => typeof id === "string" && /^\d{17,20}$/.test(id);
export function describeError(error: any): string {
    const status = error?.status ?? error?.response?.status;
    const body = error?.body ?? error?.response?.body;
    const message = typeof body?.message === "string" ? body.message : typeof error?.message === "string" ? error.message : typeof error === "string" ? error : "Discord request failed.";
    return `${message}${typeof status === "number" ? ` (HTTP ${status}${typeof body?.code === "number" ? `, code ${body.code}` : ""})` : ""}`;
}
export const deletable = (message: Message, owner: string) => message.author.id === owner && (message.type === 0 || message.type === 19);
export function snowflakeAt(ms: number) { return ((BigInt(Math.max(1420070400000, Math.floor(ms))) - 1420070400000n) << 22n).toString(); }
export function normalizeMessage(raw: any, channel: string): Message {
    if (!validId(raw?.id) || raw.channel_id !== channel || !validId(raw.author?.id)) throw Error("Discord returned an invalid message page.");
    const user = (author: any): Author => ({ id: author.id, username: author.username, global_name: author.global_name, avatar: author.avatar,
        ...(Object.hasOwn(author, "primary_guild") ? { primary_guild: author.primary_guild && {
            identity_guild_id: author.primary_guild.identity_guild_id, identity_enabled: author.primary_guild.identity_enabled,
            tag: author.primary_guild.tag, badge: author.primary_guild.badge
        } } : {}) });
    return { id: raw.id, channel_id: channel, author: user(raw.author), content: String(raw.content ?? ""), timestamp: raw.timestamp,
        type: raw.type ?? 0, edited_timestamp: raw.edited_timestamp,
        attachments: Array.isArray(raw.attachments) ? raw.attachments.map((a: any) => ({ id: a.id, filename: String(a.filename ?? "Attachment"), url: a.url, content_type: a.content_type, size: a.size })) : [],
        embeds: Array.isArray(raw.embeds) ? raw.embeds.map((e: any) => ({ title: e.title, description: e.description, url: e.url })) : [],
        referenced_message: raw.referenced_message ? { id: raw.referenced_message.id, content: String(raw.referenced_message.content ?? ""), author: raw.referenced_message.author ? user(raw.referenced_message.author) : undefined } : undefined,
        sticker_items: raw.sticker_items?.map((s: any) => ({ id: s.id, name: s.name, format_type: s.format_type })) };
}
export class Job {
    readonly owner: string;
    readonly signal: AbortSignal;
    private aborter = new AbortController();
    private paused = false;
    private resumeWaiters = new Set<() => void>();
    progress: Progress = { phase: "Ready", scanned: 0, matched: 0, deleted: 0, missing: 0, total: 0, channel: "", paused: false };
    constructor(readonly api: Transport, readonly changed: (progress: Progress) => void, readonly delay = 1500) {
        const owner = api.owner(); if (!validId(owner)) throw Error("Log in to Discord first.");
        this.owner = owner; this.signal = this.aborter.signal;
    }
    update(next: Partial<Progress>) { this.progress = { ...this.progress, ...next }; this.changed(this.progress); }
    cancel(reason = "Cancelled") { this.aborter.abort(Error(reason)); this.wake(); }
    pause() { this.paused = !this.paused; this.update({ paused: this.paused }); if (!this.paused) this.wake(); }
    private wake() { for (const fn of this.resumeWaiters) fn(); this.resumeWaiters.clear(); }
    assertAccount() {
        if (this.api.owner() !== this.owner) this.cancel("Account changed. The job was stopped.");
        if (this.signal.aborted) throw this.signal.reason;
    }
    async checkpoint() {
        this.assertAccount();
        while (this.paused) { await new Promise<void>(resolve => this.resumeWaiters.add(resolve)); this.assertAccount(); }
    }
    async sleep(ms: number) {
        this.assertAccount();
        await new Promise<void>((resolve, reject) => {
            const finish = () => { clearTimeout(timer); this.signal.removeEventListener("abort", abort); resolve(); };
            const abort = () => { clearTimeout(timer); this.signal.removeEventListener("abort", abort); reject(this.signal.reason); };
            const timer = setTimeout(finish, ms); this.signal.addEventListener("abort", abort, { once: true });
        });
    }
    async request<T>(operation: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            await this.checkpoint();
            try { return await operation(); }
            catch (error: any) {
                const status = error?.status ?? error?.response?.status;
                if (status !== 429 || attempt >= 7) throw error;
                const retry = Number(error?.body?.retry_after ?? error?.response?.body?.retry_after ?? 5);
                const wait = Math.max(1000, Math.min(Number.isFinite(retry) ? retry * 1000 : 5000, 3600000));
                this.update({ phase: `Rate limited. Waiting ${Math.ceil(wait / 1000)} seconds…` });
                await this.sleep(wait);
            }
        }
    }
    private async validate(channel: Conversation) {
        if (this.api.validateChannel) await this.request(() => this.api.validateChannel!(channel));
        else if (!this.api.privateChannel(channel.id)) throw Error("The conversation is no longer an accessible DM.");
        this.assertAccount();
    }
    async scan(channels: Conversation[], range: Range, mode: "purge" | "export", limit = 50000, filter?: TextFilter): Promise<ScanResult> {
        if (!channels.length || channels.some(c => !validId(c.id))) throw Error("Select at least one conversation or channel.");
        if (!Number.isFinite(range.before) || range.after !== undefined && (!Number.isFinite(range.after) || range.after >= range.before)) throw Error("Choose a valid date range.");
        const messages: Message[] = [], seen = new Set<string>(); let scanned = 0, ownCount = 0;
        for (const channel of channels) {
            await this.validate(channel);
            let cursor = snowflakeAt(range.before), done = false;
            while (!done) {
                this.update({ phase: mode === "purge" ? "Scanning your messages…" : "Reading conversation…", channel: channel.name });
                const body = await this.request(() => this.api.page(channel.id, cursor)); this.assertAccount();
                if (!Array.isArray(body) || body.length > 100) throw Error("Discord returned an unexpected history response.");
                if (!body.length) break;
                const rows = body.map(raw => normalizeMessage(raw, channel.id));
                const oldest = rows.reduce((a, b) => BigInt(a.id) < BigInt(b.id) ? a : b).id;
                if (BigInt(oldest) >= BigInt(cursor)) throw Error("History pagination stopped advancing. No purge was started.");
                for (const message of rows) {
                    if (seen.has(message.id)) continue; seen.add(message.id);
                    if (++scanned > limit) throw Error(`Scan limit of ${limit.toLocaleString()} messages reached. Narrow the date range and try again.`);
                    const timestamp = Date.parse(message.timestamp);
                    if (!Number.isFinite(timestamp)) throw Error("A message has an invalid timestamp.");
                    if (range.after !== undefined && timestamp < range.after) { done = true; continue; }
                    if (timestamp >= range.before) continue;
                    const own = deletable(message, this.owner); if (own) ownCount++;
                    if (mode === "export" || own && matchesText(message.content, filter)) messages.push(message);
                }
                cursor = oldest; this.update({ scanned, matched: messages.length });
                if (!done) await this.sleep(Math.max(350, this.delay / 3));
            }
        }
        this.assertAccount();
        return { owner: this.owner, channels: channels.map(c => ({ ...c })), range: { ...range }, messages, scanned, ownCount, filter: mode === "purge" && filter ? { ...filter } : undefined };
    }
    async purge(plan: ScanResult) {
        if (plan.owner !== this.owner) throw Error("The preview belongs to another account. Scan again.");
        const channels = new Map(plan.channels.map(c => [c.id, c]));
        if (plan.messages.some(m => !deletable(m, this.owner) || !validId(m.id) || !channels.has(m.channel_id) || !matchesText(m.content, plan.filter))) throw Error("The purge preview contains an invalid candidate. Scan again.");
        for (const channel of channels.values()) await this.validate(channel);
        this.update({ phase: "Deleting your messages…", scanned: plan.scanned, matched: plan.messages.length, total: plan.messages.length, deleted: 0, missing: 0 });
        const deletedChannels = new Set<string>();
        for (const candidate of plan.messages) {
            await this.checkpoint();
            this.update({ channel: plan.channels.find(c => c.id === candidate.channel_id)?.name ?? candidate.channel_id });
            let stage = "verify";
            try {
                // Verify ownership again immediately before each delete.
                const raw = await this.request(() => this.api.message(candidate.channel_id, candidate.id));
                const current = normalizeMessage(raw, candidate.channel_id);
                if (current.id !== candidate.id || !deletable(current, this.owner)) throw Error("Message ownership no longer matches the preview. Purge stopped.");
                if (!matchesText(current.content, plan.filter)) {
                    this.update({ skipped: (this.progress.skipped ?? 0) + 1 });
                    await this.sleep(Math.max(1000, this.delay));
                    continue;
                }
                stage = "delete";
                await this.request(() => this.api.remove(candidate.channel_id, candidate.id));
                deletedChannels.add(candidate.channel_id);
                this.update({ deleted: this.progress.deleted + 1, phase: "Deleting your messages…" });
            } catch (error: any) {
                if ((error?.status ?? error?.response?.status) === 404) this.update({ missing: this.progress.missing + 1 });
                else throw Error(`Could not ${stage} message: ${describeError(error)}`);
            }
            await this.sleep(Math.max(1000, this.delay));
        }
        this.update({ phase: "Purge complete" });
        return deletedChannels;
    }
}
