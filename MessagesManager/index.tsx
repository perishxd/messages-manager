/* SPDX-License-Identifier: GPL-3.0-or-later */
import pluginStyle from "./style.css?managed";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, GuildStore, PermissionStore, PermissionsBits, FluxDispatcher, Modal, React, RelationshipStore, RestAPI, SearchableSelect, Select, SelectedChannelStore, UserStore, closeModal, openModal, useStateFromStores } from "@webpack/common";
import { Conversation, Job, Message, Progress, Range, ScanResult, TextFilter, Transport, describeError, validId } from "./core";
import { captureTheme } from "./export";
import { buildArchive } from "./archive";
import { downloadDesktopMedia } from "./desktopMedia";
import { VERSION } from "./version";

let enabled = false, active: Job | undefined, modalKey: string | undefined;
interface Draft {
    owner: string | undefined; context?: string; channels: Conversation[]; selected: Set<string>; search: string;
    after: string; before: string; format: string; delay: number; tab: "dm" | "server"; guild: string; filter: TextFilter;
}
interface RunState { busy: boolean; plan?: ScanResult; status: string; progress?: Progress; }
let draft: Draft | undefined, stateOwner: string | undefined;
let runState: RunState = { busy: false, status: "" };
const runListeners = new Set<() => void>();
function updateRun(update: Partial<RunState>) { runState = { ...runState, ...update }; for (const notify of runListeners) notify(); }
function subscribeRun(notify: () => void) { runListeners.add(notify); return () => { runListeners.delete(notify); }; }
function getRun() { return runState; }
function updateOwned(owner: string | undefined, update: Partial<RunState>) { if (enabled && stateOwner === owner) updateRun(update); }
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
function ManagerIcon() {
    return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8 9h9M8 13h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>;
}
function TitlebarButton() {
    const { busy, progress } = React.useSyncExternalStore(subscribeRun, getRun);
    const id = useStateFromStores([SelectedChannelStore, ChannelStore], () => {
        const selected = SelectedChannelStore.getChannelId();
        return validId(selected) ? selected : undefined;
    });
    return <HeaderBarIcon tooltip={busy ? `Messages Manager — ${progress?.paused ? "paused" : "running"}` : "Messages Manager"} icon={ManagerIcon} onClick={() => openManager(id)} />;
}
const settings = definePluginSettings({ manager: { type: OptionType.COMPONENT, component: () => <div>
    <Button onClick={() => openManager()}>Open Messages Manager</Button>
</div> } });
function checked(response: any) {
    if (response?.ok === false || response?.status >= 400)
        throw Object.assign(Error(response?.body?.message ?? `Discord returned ${response.status}.`), { status: response.status, body: response.body });
    return response;
}
const api: Transport = {
    owner: () => UserStore.getCurrentUser()?.id,
    privateChannel: id => { const channel = ChannelStore.getChannel(id); return !!channel && (channel.type === 1 || channel.type === 3); },
    validateChannel: async target => {
        const channel = ChannelStore.getChannel(target.id);
        if (target.guildId) {
            if (!channel || channel.guild_id !== target.guildId || !readableServerChannel(channel)) throw Error("This server channel is no longer accessible.");
        } else if (!api.privateChannel(target.id)) {
            await resolveDM(target.id);
        }
    },
    page: async (id, before) => checked(await RestAPI.get({ url: `/channels/${id}/messages`, query: { limit: 100, before }, retries: 0 })).body,
    message: async (id, message) => {
        // The client retrieves individual messages through history with `around`.
        const rows = checked(await RestAPI.get({ url: `/channels/${id}/messages`, query: { around: message, limit: 1 }, retries: 0 })).body;
        if (!Array.isArray(rows)) throw Error("Discord returned an unexpected message verification response.");
        const found = rows.find(row => row.id === message);
        if (!found) throw Object.assign(Error("The message no longer exists."), { status: 404 });
        return found;
    },
    remove: async (id, message) => {
        checked(await RestAPI.del({ url: `/channels/${id}/messages/${message}`, retries: 0 }));
        FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: id, id: message });
    }
};
type DiscordChannel = NonNullable<ReturnType<typeof ChannelStore.getChannel>>;
function readableServerChannel(channel: DiscordChannel) {
    return [0, 5, 10, 11, 12].includes(channel.type)
        && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)
        && PermissionStore.can(PermissionsBits.READ_MESSAGE_HISTORY, channel);
}
function serverChannels(guild: string): Conversation[] {
    if (!GuildStore.getGuild(guild)) return [];
    return Object.values(ChannelStore.getMutableGuildChannelsForGuild(guild) ?? {})
        .filter(readableServerChannel).map(c => ({ id: c.id, name: c.name, guildId: guild }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
function dmName(channel: { name?: string; recipients?: (string | { id: string; username?: string; global_name?: string })[]; id: string }) {
    return channel.name || channel.recipients?.map(person => {
        if (typeof person !== "string") return person.global_name || person.username || person.id;
        const user = UserStore.getUser(person);
        return user?.globalName || user?.username || person;
    }).join(", ") || "DM " + channel.id;
}
async function resolveDM(id: string): Promise<Conversation> {
    if (!validId(id)) throw Error("Enter a valid DM channel ID.");
    const body = checked(await RestAPI.get({ url: `/channels/${id}`, retries: 0 })).body;
    if (body?.id !== id || ![1, 3].includes(body.type)) throw Error("That ID does not belong to a DM.");
    return { id, name: dmName(body) };
}
type AfterPurge = { close: boolean; unadd: boolean; block: boolean; leave: boolean; leaveGroup: boolean; };
const noActions: AfterPurge = { close: false, unadd: false, block: false, leave: false, leaveGroup: false };
async function finishPurge(job: Job, channels: Conversation[], actions: AfterPurge) {
    const outcomes: string[] = [];
    const run = async (label: string, operation: () => Promise<unknown>) => {
        job.update({ phase: label });
        try {
            await job.request(operation);
            outcomes.push(label + " ✓");
        } catch (error) {
            job.assertAccount();
            outcomes.push(label + " failed: " + describeError(error));
        }
        await job.sleep(job.delay);
    };
    const guilds = new Set<string>(), users = new Set<string>();
    for (const channel of channels) {
        job.assertAccount();
        if (channel.guildId) {
            if (actions.leave && !guilds.has(channel.guildId)) {
                const guild = channel.guildId;
                guilds.add(guild);
                await run("Leave " + (GuildStore.getGuild(guild)?.name ?? guild), () =>
                    RestAPI.del({ url: `/users/@me/guilds/${guild}`, retries: 0 }).then(checked));
            }
            continue;
        }
        if (!actions.close && !actions.unadd && !actions.block && !actions.leaveGroup) continue;
        let body: any;
        try {
            body = await job.request(async () => checked(await RestAPI.get({ url: `/channels/${channel.id}`, retries: 0 })).body);
        } catch (error) {
            job.assertAccount();
            outcomes.push(channel.name + ": " + describeError(error));
            continue;
        }
        if (body?.id !== channel.id) continue;
        if (body.type === 3 && actions.leaveGroup)
            await run("Leave group DM " + channel.name, () =>
                RestAPI.del({ url: `/channels/${channel.id}`, retries: 0 }).then(checked));
        if (body.type !== 1) continue;
        const person = body.recipients?.[0]?.id;
        if (validId(person) && person !== job.owner && !users.has(person)) {
            users.add(person);
            if (actions.unadd && RelationshipStore.isFriend(person))
                await run("Remove friend " + channel.name, () => RestAPI.del({ url: `/users/@me/relationships/${person}`, retries: 0 }).then(checked));
            if (actions.block)
                await run("Block " + channel.name, () => RestAPI.put({ url: `/users/@me/relationships/${person}`, body: { type: 2 }, retries: 0 }).then(checked));
        }
        if (actions.close)
            await run("Close " + channel.name, () => RestAPI.del({ url: `/channels/${channel.id}`, retries: 0 }).then(checked));
    }
    return outcomes;
}
function rememberDMs(owner: string | undefined, rows: Conversation[]): Conversation[] {
    if (!owner) return rows;
    const key = `messages-manager:dms:${owner}`;
    try {
        const previous = localStorage.getItem(key);
        const saved = JSON.parse(previous ?? "[]");
        const list = new Map<string, Conversation>(rows.map(c => [c.id, c]));
        if (Array.isArray(saved)) for (const c of saved) {
            if (validId(c?.id) && typeof c.name === "string" && !list.has(c.id)) list.set(c.id, { id: c.id, name: c.name });
        }
        const merged = [...list.values()];
        const serialized = JSON.stringify(merged.slice(0, 5000));
        if (serialized !== previous) localStorage.setItem(key, serialized);
        return merged;
    } catch { return rows; }
}
function conversations(): Conversation[] {
    const rows = new Map<string, Conversation>();
    for (const channel of [
        ...ChannelStore.getSortedPrivateChannels(),
        ...Object.values(ChannelStore.getMutablePrivateChannels?.() ?? {})
    ]) {
        if ((channel?.type === 1 || channel?.type === 3) && !rows.has(channel.id))
            rows.set(channel.id, { id: channel.id, name: dmName(channel) });
    }
    for (const [userId, id] of Object.entries(ChannelStore.getMutableDMsByUserIds?.() ?? {})) {
        if (validId(id) && !rows.has(id)) rows.set(id, { id, name: dmName({ id, recipients: [userId] }) });
    }
    return rememberDMs(api.owner(), [...rows.values()]);
}
function rememberOpenDMs() { if (enabled) conversations(); }
function enrich(message: Message): Message {
    const enrichAuthor = (author: Message["author"]) => {
        const cached = UserStore.getUser(author.id);
        const guild = cached?.primaryGuild;
        return { ...author, ...(!Object.hasOwn(author, "primary_guild") && guild ? { primary_guild: {
            identity_guild_id: guild.identityGuildId, identity_enabled: guild.identityEnabled, tag: guild.tag, badge: guild.badge
        } } : {}) };
    };
    return { ...message, author: enrichAuthor(message.author), referenced_message: message.referenced_message ? {
        ...message.referenced_message, author: message.referenced_message.author ? enrichAuthor(message.referenced_message.author) : undefined
    } : undefined };
}
function download(name: string, content: string | Blob, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a"); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function accountChanged() {
    const owner = api.owner();
    if (active && owner !== active.owner) active.cancel("Account changed. The job was stopped.");
    if (owner !== stateOwner) {
        stateOwner = owner; draft = undefined;
        updateRun({ busy: !!active, plan: undefined, progress: undefined, status: active ? "Account changed. The job was stopped." : "" });
    }
}
function openManager(initial?: string) {
    if (!enabled || modalKey) return;
    accountChanged();
    if (!active && draft && validId(initial) && draft.context !== initial) {
        const guild = ChannelStore.getChannel(initial)?.guild_id ?? "";
        const tab = guild ? "server" : "dm";
        const channels = guild ? serverChannels(guild) : conversations();
        draft = { ...draft, context: initial, tab, guild, channels, selected: new Set(channels.some(c => c.id === initial) ? [initial] : []), search: "" };
        updateRun({ busy: false, plan: undefined, progress: undefined, status: "" });
    }
    if (!draft && !active) updateRun({ busy: false, plan: undefined, progress: undefined, status: "" });
    modalKey = openModal(props => <Manager {...props} initial={initial} minimize={() => closeModal("messages-manager")} />, {
        modalKey: "messages-manager", onCloseCallback: () => {
            modalKey = undefined;
            // Backdrop clicks and Escape may close the modal without calling its onClose prop.
            // Only the explicit cancellation controls stop a job.
            updateRun({});
        }
    });
}
function Manager({ initial, onClose, transitionState, minimize }: { initial?: string; onClose(): void; transitionState: number; minimize(): void; }) {
    const owner = api.owner();
    const saved = draft?.owner === owner ? draft : undefined;
    const initialId = initial ?? SelectedChannelStore.getChannelId();
    const [guild, setGuild] = React.useState(saved?.guild ?? (initialId ? ChannelStore.getChannel(initialId)?.guild_id ?? "" : ""));
    const [tab, setTab] = React.useState<"dm" | "server">(saved?.tab ?? (guild ? "server" : "dm"));
    const [channels, setChannels] = React.useState(() => tab === "dm" ? conversations() : serverChannels(guild));
    const [filter, setFilter] = React.useState<TextFilter>(saved?.filter ?? { text: "", mode: "exact" });
    const context = React.useRef(saved?.context ?? initialId).current;
    const [selected, setSelected] = React.useState<Set<string>>(() => saved?.selected ?? new Set(initialId && channels.some(c => c.id === initialId) ? [initialId] : []));
    const [search, setSearch] = React.useState(saved?.search ?? "");
    const [after, setAfter] = React.useState(saved?.after ?? ""), [before, setBefore] = React.useState(saved?.before ?? "");
    const [format, setFormat] = React.useState(saved?.format ?? "zip"), [delay, setDelay] = React.useState(saved?.delay ?? 1500);
    const { busy, plan, status, progress } = React.useSyncExternalStore(subscribeRun, getRun);
    const setPlan = (plan: ScanResult | undefined) => updateOwned(owner, { plan });
    const setStatus = (status: string) => updateOwned(owner, { status });
    const saveDraft = () => { draft = { owner, context, channels, selected: new Set(selected), search, after, before, format, delay, tab, guild, filter }; };
    React.useLayoutEffect(saveDraft, [owner, channels, selected, search, after, before, format, delay, tab, guild, filter]);
    const [actions, setActions] = React.useState<AfterPurge>(noActions);
    const [confirmation, setConfirmation] = React.useState("");
    const [account, setAccount] = React.useState(owner);
    const lastAccount = React.useRef(owner);
    const listRef = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const list = listRef.current;
        const row = list?.querySelector<HTMLElement>(".dmm-channel.selected");
        if (list && row) list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2);
    }, []);
    React.useEffect(() => {
        const changed = () => {
            const next = api.owner(); if (next === lastAccount.current) return;
            lastAccount.current = next; setAccount(next); setPlan(undefined); setConfirmation(""); setSelected(new Set()); setTab("dm"); setGuild(""); setFilter({text:"",mode:"exact"}); setChannels(conversations());
        };
        UserStore.addChangeListener(changed);
        return () => { UserStore.removeChangeListener(changed); };
    }, []);
    const close = () => { active?.cancel("Cancelled and closed."); draft = undefined; updateRun({ plan: undefined }); onClose(); };
    const hide = () => { saveDraft(); minimize(); };
    const invalidate = () => { setPlan(undefined); setConfirmation(""); setActions(noActions); };
    function changeScope(next: "dm" | "server", server = guild) {
        setTab(next); setGuild(server); setSearch(""); setSelected(new Set());
        setChannels(next === "dm" ? conversations() : serverChannels(server)); invalidate();
    }
    function range(): Range {
        const from = after ? Date.parse(after) : undefined;
        const until = before ? Date.parse(before) + 86400000 : Date.now();
        if (from !== undefined && (!Number.isFinite(from) || from >= until) || !Number.isFinite(until)) throw Error("Choose a valid date range.");
        return { after: from, before: Math.min(until, Date.now()) };
    }
    async function run(mode: "preview" | "export" | "purge") {
        if (active || !enabled) return;
        let job: Job | undefined;
        let outcome = "", succeeded = false;
        try {
            const scope = channels.filter(c => selected.has(c.id));
            if (!scope.length) throw Error("Select at least one conversation or channel.");
            const preview = plan;
            if (mode === "purge" && (!preview || confirmation !== `DELETE ${preview.messages.length}` || preview.owner !== api.owner())) throw Error("Scan again and enter the confirmation shown below.");
            const limits = range();
            // Capture the theme before a potentially long export changes the UI.
            const theme = mode === "export" ? captureTheme() : undefined;
            job = new Job(api, update => updateOwned(owner, { progress: update }), Math.max(1000, Math.min(10000, delay || 1500)));
            active = job; saveDraft(); updateOwned(owner, { busy: true, status: "", progress: undefined });
            if (mode === "purge") {
                setPlan(undefined); setConfirmation("");
                const deletedChannels = await job.purge(preview!);
                outcome = `Deleted ${job.progress.deleted.toLocaleString()} of your messages.${job.progress.missing ? ` ${job.progress.missing} already gone.` : ""}${job.progress.skipped ? ` ${job.progress.skipped} edited messages skipped.` : ""}`;
                const followups = await finishPurge(job, preview!.channels.filter(c => deletedChannels.has(c.id)), actions);
                if (followups.length) outcome += " " + followups.join(" · ");
            } else {
                invalidate();
                const result = await job.scan(scope, limits, mode === "preview" ? "purge" : "export", undefined, filter);
                if (mode === "preview") {
                    setPlan(result); outcome = `Preview ready: ${result.messages.length.toLocaleString()} of your messages can be deleted. Nothing has been deleted.`;
                } else {
                    result.messages = result.messages.map(enrich);
                    job.assertAccount();
                    const name = `MessagesManager-${new Date().toISOString().replace(/[:.]/g, "-")}`;
                    if (format !== "json") {
                        const archive = await buildArchive(result, theme!, {
                            signal: job.signal, checkpoint: () => job!.checkpoint(), progress: phase => job!.update({ phase }), fallback: downloadDesktopMedia
                        });
                        job.assertAccount();
                        download(`${name}.zip`, new Blob([new Uint8Array(archive.bytes)]), "application/zip");
                        outcome = `Exported ${result.messages.length.toLocaleString()} messages from ${result.channels.length} conversations. ${archive.downloaded} media files downloaded.${archive.missed ? ` ${archive.missed} file references could not be saved; open media-report.html in the ZIP.` : ""}`;
                    } else {
                        download(`${name}.json`, JSON.stringify({ format: 1, exportedAt: new Date().toISOString(), theme, ...result }, null, 2), "application/json;charset=utf-8");
                        outcome = `Exported ${result.messages.length.toLocaleString()} messages from ${result.channels.length} conversations.`;
                    }
                }
            }
            succeeded = true;
        } catch (error) {
            outcome = `${describeError(error)}${job?.progress.deleted ? ` ${job.progress.deleted} messages were already deleted.` : ""}`;
        } finally {
            setStatus(outcome);
            if (job && active === job) {
                active = undefined; updateRun({ busy: false });
                if (enabled && owner === api.owner()) void showNotification({
                    title: succeeded ? mode === "preview" ? "MessagesManager — preview ready" : "MessagesManager — finished" : "MessagesManager — job stopped",
                    body: outcome, noPersist: true, onClick: () => { if (owner === api.owner()) openManager(); }
                }).catch(() => {});
            }
        }
    }
    const visible = channels.filter(c => `${c.name} ${c.id}`.toLowerCase().includes(search.toLowerCase()));
    const user = UserStore.getCurrentUser();
    return <Modal title="Messages Manager" subtitle={`Version ${VERSION}`} size="xl" transitionState={transitionState} onClose={hide} actions={[{ text: "Minimize", variant: "secondary", onClick: hide }, { text: busy ? "Cancel and close" : "Close", variant: "secondary", onClick: close }]}>
        <div className="dmm">
            <div className="dmm-account"><span>Signed in as <strong>{user?.globalName || user?.username || "Logged out"}</strong></span><code>{account}</code></div>
            <div className="dmm-actions dmm-tabs" role="group" aria-label="Message source">
                <Button variant={tab === "dm" ? "primary" : "secondary"} aria-pressed={tab === "dm"} disabled={busy} onClick={() => { if (tab !== "dm") changeScope("dm"); }}>DMs</Button>
                <Button variant={tab === "server" ? "primary" : "secondary"} aria-pressed={tab === "server"} disabled={busy} onClick={() => { if (tab !== "server") changeScope("server"); }}>Servers</Button>
            </div>
            <div className="dmm-grid">
                <section className="dmm-sidebar"><Heading tag="h3">{tab === "dm" ? "Conversations" : "Channels"} <span className="dmm-count">{selected.size} selected</span></Heading>
                    {tab === "server" ? <div className="dmm-field dmm-server-picker">
                        <SearchableSelect
                            placeholder="Choose a server" isDisabled={busy} value={guild || undefined} closeOnSelect={true} maxVisibleItems={8}
                            options={Object.values(GuildStore.getGuilds()).sort((a,b) => a.name.localeCompare(b.name)).map(g => ({ value: g.id, label: g.name }))}
                            onChange={value => { if (typeof value === "string") changeScope("server", value); }}
                        />
                    </div> : null}
                    <input aria-label="Search conversations or channels" placeholder="Search name or channel ID" value={search} disabled={busy} onChange={e => setSearch(e.currentTarget.value)} />
                    <div className="dmm-actions"><Button size="xs" variant="secondary" disabled={busy} onClick={() => { setSelected(new Set(visible.map(c => c.id))); invalidate(); }}>Select results</Button>
                        <Button size="xs" variant="secondary" disabled={busy} onClick={() => { setSelected(new Set()); invalidate(); }}>Clear</Button>
                        <Button size="xs" variant="secondary" disabled={busy} onClick={() => { setChannels(tab === "dm" ? conversations() : serverChannels(guild)); invalidate(); }}>Refresh</Button></div>
                    <div className="dmm-channels" ref={listRef}>{visible.map(c => <label key={c.id} className={selected.has(c.id) ? "dmm-channel selected" : "dmm-channel"}>
                        <input type="checkbox" checked={selected.has(c.id)} disabled={busy} onChange={e => { const next = new Set(selected); if (e.currentTarget.checked) next.add(c.id); else next.delete(c.id); setSelected(next); invalidate(); }} />
                        <span>{c.name}<small>{c.id}</small></span></label>)}{!visible.length && <p>No matches.</p>}</div>
                </section>
                <section className="dmm-options"><Heading tag="h3">Date range (UTC)</Heading>
                    <div className="dmm-dates"><label>From<input type="date" value={after} disabled={busy} onChange={e => { setAfter(e.currentTarget.value); invalidate(); }} /></label><label>Through<input type="date" value={before} disabled={busy} onChange={e => { setBefore(e.currentTarget.value); invalidate(); }} /></label></div>
                    <div className="dmm-panel dmm-export"><div className="dmm-card-heading"><span className="dmm-card-symbol" aria-hidden="true">↓</span><Heading tag="h3">Export</Heading></div>
                        <div className="dmm-format"><Select
                            options={[{ label: "Themed HTML + media (ZIP)", value: "zip" }, { label: "JSON archive", value: "json" }]}
                            placeholder="Export format" isDisabled={busy} closeOnSelect={true}
                            select={setFormat} isSelected={value => value === format} serialize={value => value}
                        /></div>
                        <Button disabled={busy || !selected.size} onClick={() => void run("export")}>Export selection</Button>
                    </div>
                    <div className="dmm-panel dmm-delete"><div className="dmm-card-heading"><span className="dmm-card-symbol" aria-hidden="true">×</span><Heading tag="h3">Delete your messages</Heading><span className="dmm-permanent">Permanent</span></div> 
                        <label>Message text<input placeholder="Optional" value={filter.text} disabled={busy} onChange={e => { setFilter({ ...filter, text: e.currentTarget.value }); invalidate(); }} /></label>
                        <div className="dmm-field"><span>Match</span><Select
                            options={[{ value: "exact", label: "Exact text" }, { value: "contains", label: "Contains text" }]}
                            placeholder="Match type" isDisabled={busy} closeOnSelect={true}
                            select={value => { setFilter({ ...filter, mode: value === "contains" ? "contains" : "exact" }); invalidate(); }}
                            isSelected={value => value === filter.mode} serialize={value => value}
                        /></div>
                        <label>Request spacing (milliseconds)<input type="number" min={1000} max={10000} step={100} value={delay} disabled={busy} onChange={e => setDelay(Number(e.currentTarget.value))} /></label>
                        <Button variant="secondary" disabled={busy || !selected.size} onClick={() => void run("preview")}>Scan and preview</Button>
                        {plan && <div className="dmm-confirm"><strong>{plan.messages.length.toLocaleString()} of your messages · {plan.channels.length} selected</strong>
                            <div className="dmm-samples">{plan.messages.slice(0, 5).map(m => <div key={m.id}>{m.timestamp.slice(0, 10)} · {m.content.slice(0, 100) || "[Attachment / empty message]"}</div>)}</div>
                            <fieldset className="dmm-after-purge" disabled={busy || !plan.messages.length}>
                                <legend>After deletion (optional)</legend>
                                {(tab === "dm"
                                    ? [["close", "Close purged 1:1 DMs"], ["unadd", "Remove purged 1:1 DM recipients from friends"], ["block", "Block purged 1:1 DM recipients"], ["leaveGroup", "Leave purged group DMs"]] as const
                                    : [["leave", "Leave the servers where messages were deleted"]] as const
                                ).map(([key, label]: readonly [keyof AfterPurge, string]) => <label key={key}>
                                    <input type="checkbox" checked={actions[key]} onChange={e => { setActions({ ...actions, [key]: e.currentTarget.checked }); setConfirmation(""); }} />
                                    {label}
                                </label>)}
                            </fieldset>
                            <label>Type <code>DELETE {plan.messages.length}</code><input value={confirmation} onChange={e => setConfirmation(e.currentTarget.value)} disabled={busy} autoComplete="off" /></label>
                            <Button variant="dangerPrimary" disabled={busy || !plan.messages.length || confirmation !== `DELETE ${plan.messages.length}`} onClick={() => void run("purge")}>Delete {plan.messages.length.toLocaleString()} of my messages</Button></div>}
                    </div>
                </section>
            </div>
            {(busy || status) && <div className="dmm-status" role="status">{status || progress?.phase}<div className="dmm-help">{progress && `Scanned ${progress.scanned.toLocaleString()} · Matched ${progress.matched.toLocaleString()} · Deleted ${progress.deleted.toLocaleString()}${progress.total ? ` / ${progress.total.toLocaleString()}` : ""}`}</div>{busy && <><div>{progress?.channel}</div><div className="dmm-actions"><Button variant="secondary" size="small" onClick={() => active?.pause()}>{progress?.paused ? "Resume" : "Pause"}</Button><Button variant="dangerSecondary" size="small" onClick={() => active?.cancel("Cancelled. A request already in flight may still finish.")}>Cancel</Button></div></>}</div>}
        </div>
    </Modal>;
}
export default definePlugin({
    name: "MessagesManager", description: "Manage DMs and server channels, delete your messages, and export conversations with your theme and guild tags.",
    authors: [{ name: "perishxd", id: 1113854342517243904n }], settings,
    patches: [{
        find: '?"BACK_FORWARD_NAVIGATION":',
        replacement: {
            match: /(trailing:\(0,\i\.jsxs?\)\([^,]+,\{children:\[)/,
            replace: "$1$self.renderTitlebarButton(),"
        }
    }],
    renderTitlebarButton: () => <ErrorBoundary key="messages-manager" noop><TitlebarButton /></ErrorBoundary>,
    toolboxActions: { "Open Messages Manager": () => openManager() },
    start() { enableStyle(pluginStyle); enabled = true; accountChanged(); UserStore.addChangeListener(accountChanged); ChannelStore.addChangeListener(rememberOpenDMs); rememberOpenDMs(); },
    stop() { enabled = false; draft = undefined; active?.cancel("MessagesManager disabled."); UserStore.removeChangeListener(accountChanged); ChannelStore.removeChangeListener(rememberOpenDMs); if (modalKey) closeModal(modalKey); disableStyle(pluginStyle); }
});
