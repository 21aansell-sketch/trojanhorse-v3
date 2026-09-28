import { logger } from "@vendetta";

import {
    findByName,
    findByProps,
    findByStoreName,
} from "@vendetta/metro/common";

import { after } from "@vendetta/patcher";
import { showConfirmationAlert } from "@vendetta/ui/alerts";
import { ReactNative as RN } from "@metro/common";

type Message = {
    id: string;
    channel_id?: string;
    content?: string;
    author?: {
        id: string;
        username?: string;
    };
};

type LocalEdit = {
    content: string;
    originalContent: string;
    updatedAt: number;
};

const edits = new Map<string, LocalEdit>();

/*
 * Vendetta's storage API differs slightly between versions, so this
 * plugin keeps the runtime map simple and uses the plugin's storage
 * object when available.
 */
const storage = (() => {
    try {
        // @ts-ignore - Vendetta exposes plugin storage at runtime.
        return require("@vendetta/plugin").storage as Record<string, unknown>;
    } catch {
        return {} as Record<string, unknown>;
    }
})();

function storageKey(channelId: string, messageId: string) {
    return `${channelId}:${messageId}`;
}

function loadEdits() {
    try {
        const saved = storage.localEdits;

        if (!saved || typeof saved !== "object") return;

        for (const [key, value] of Object.entries(
            saved as Record<string, LocalEdit>,
        )) {
            if (
                value &&
                typeof value.content === "string" &&
                typeof value.originalContent === "string"
            ) {
                edits.set(key, value);
            }
        }
    } catch (e) {
        logger.error("Local Message Editor: failed to load edits", e);
    }
}

function saveEdits() {
    try {
        storage.localEdits = Object.fromEntries(edits);
    } catch (e) {
        logger.error("Local Message Editor: failed to save edits", e);
    }
}

function getEdit(message: Message): LocalEdit | undefined {
    if (!message.channel_id) return undefined;

    return edits.get(storageKey(message.channel_id, message.id));
}

function setEdit(message: Message, content: string) {
    if (!message.channel_id) return;

    const key = storageKey(message.channel_id, message.id);

    edits.set(key, {
        content,
        originalContent: message.content ?? "",
        updatedAt: Date.now(),
    });

    saveEdits();
}

function removeEdit(message: Message) {
    if (!message.channel_id) return;

    edits.delete(storageKey(message.channel_id, message.id));
    saveEdits();
}

/**
 * Finds a text input/message editing component.
 *
 * This is intentionally resolved lazily because Discord changes its
 * internal component names between releases.
 */
function getTextInput() {
    try {
        return findByName("TextInput", false);
    } catch {
        return null;
    }
}

/**
 * Open a native React Native prompt.
 *
 * Vendetta/Discord versions have changed their modal APIs, so the
 * implementation uses the available Alert/Prompt primitives when
 * present and falls back to a simple confirmation dialog.
 */
function promptForEdit(message: Message) {
    const current = getEdit(message)?.content ?? message.content ?? "";

    try {
        const Alert = RN?.Alert;

        if (Alert?.prompt) {
            Alert.prompt(
                "Edit message locally",
                "Only you will see this change.",
                [
                    {
                        text: "Cancel",
                        style: "cancel",
                    },
                    {
                        text: "Save",
                        onPress: (value: string | undefined) => {
                            if (typeof value !== "string") return;

                            setEdit(message, value);
                            forceMessageRefresh();
                        },
                    },
                ],
                "plain-text",
                current,
            );

            return;
        }
    } catch (e) {
        logger.error("Local Message Editor: prompt failed", e);
    }

    /*
     * iOS/Android Discord builds do not always expose Alert.prompt.
     * Keeping this fallback prevents the plugin from crashing.
     */
    showConfirmationAlert({
        title: "Local Message Editor",
        content:
            "Your Discord build does not expose the text prompt API required by this version of the plugin.",
        confirmText: "OK",
        onConfirm: () => {},
    });
}

/**
 * Force Discord's message list to render again.
 *
 * MessageStore itself is not modified. We only dispatch a harmless
 * store update so the patched render path gets called again.
 */
function forceMessageRefresh() {
    try {
        const Dispatcher = findByProps("dispatch", "subscribe");

        Dispatcher?.dispatch({
            type: "LOCAL_MESSAGE_EDITOR_UPDATE",
            timestamp: Date.now(),
        });
    } catch (e) {
        logger.error("Local Message Editor: refresh failed", e);
    }
}

/**
 * Add the "Edit Locally" option to Discord's message action sheet.
 *
 * Discord has changed the message-action module several times, so this
 * searches a few common implementations rather than depending on one
 * mangled module name.
 */
function patchMessageActions() {
    const unpatches: (() => void)[] = [];

    const candidates = [
        findByProps("openMessageActions"),
        findByProps("getMessageActions"),
        findByProps("showMessageActions"),
    ];

    for (const module of candidates) {
        if (!module) continue;

        for (const method of [
            "openMessageActions",
            "getMessageActions",
            "showMessageActions",
        ]) {
            if (typeof module[method] !== "function") continue;

            try {
                const unpatch = after(module, method, (_args, result) => {
                    try {
                        const message =
                            _args?.find(
                                (x: unknown) =>
                                    x &&
                                    typeof x === "object" &&
                                    typeof (x as Message).id === "string",
                            ) as Message | undefined;

                        if (!message || !result) return result;

                        const action = {
                            label: "Edit Locally",
                            onPress: () => promptForEdit(message),
                        };

                        if (Array.isArray(result)) {
                            return [
                                action,
                                ...result,
                            ];
                        }

                        if (Array.isArray(result?.options)) {
                            return {
                                ...result,
                                options: [
                                    action,
                                    ...result.options,
                                ],
                            };
                        }

                        return result;
                    } catch (e) {
                        logger.error(
                            "Local Message Editor: action patch failed",
                            e,
                        );

                        return result;
                    }
                });

                unpatches.push(unpatch);
            } catch {
                // Module/method does not match this Discord build.
            }
        }
    }

    return unpatches;
}

/**
 * Patch the component which renders individual Discord messages.
 *
 * We deliberately modify the props used for rendering rather than
 * mutating Discord's actual MessageStore/API data.
 */
function patchMessageRenderer() {
    const unpatches: (() => void)[] = [];

    const possibleComponents = [
        findByName("Message", false),
        findByName("MessageContent", false),
        findByName("MessageView", false),
    ];

    for (const Component of possibleComponents) {
        if (!Component?.prototype?.render) continue;

        try {
            const unpatch = after(
                Component.prototype,
                "render",
                (_args, result) => {
                    try {
                        const props = Component.prototype.props;

                        const message =
                            props?.message ??
                            props?.msg ??
                            props?.messageRecord;

                        if (!message?.id) return result;

                        const edit = getEdit(message);

                        if (!edit) return result;

                        /*
                         * React elements are immutable-ish from our
                         * perspective, so clone the element and replace
                         * message-related props recursively.
                         */
                        return replaceMessageInElement(
                            result,
                            message.id,
                            edit.content,
                        );
                    } catch (e) {
                        logger.error(
                            "Local Message Editor: renderer patch failed",
                            e,
                        );

                        return result;
                    }
                },
            );

            unpatches.push(unpatch);
        } catch {
            // Component doesn't match this Discord version.
        }
    }

    return unpatches;
}

/**
 * Recursively replaces message.content in the React element tree.
 *
 * This is intentionally conservative: only objects containing a
 * matching message id are changed.
 */
function replaceMessageInElement(
    element: any,
    messageId: string,
    content: string,
): any {
    if (!element || typeof element !== "object") {
        return element;
    }

    if (Array.isArray(element)) {
        return element.map((child) =>
            replaceMessageInElement(child, messageId, content),
        );
    }

    if (!element.props) {
        return element;
    }

    const props = element.props;

    let changed = false;
    let nextProps = props;

    for (const key of ["message", "msg", "messageRecord"]) {
        const message = props[key];

        if (
            message &&
            typeof message === "object" &&
            message.id === messageId
        ) {
            nextProps = {
                ...nextProps,
                [key]: {
                    ...message,
                    content,
                },
            };

            changed = true;
        }
    }

    if (props.children) {
        const children = replaceMessageInElement(
            props.children,
            messageId,
            content,
        );

        if (children !== props.children) {
            nextProps = {
                ...nextProps,
                children,
            };

            changed = true;
        }
    }

    if (!changed) {
        return element;
    }

    return {
        ...element,
        props: nextProps,
    };
}

let unpatches: (() => void)[] = [];

export default {
    onLoad: () => {
        logger.log("Local Message Editor loaded");

        loadEdits();

        unpatches.push(...patchMessageActions());
        unpatches.push(...patchMessageRenderer());

        logger.log(
            `Local Message Editor loaded ${edits.size} saved local edits`,
        );
    },

    onUnload: () => {
        for (const unpatch of unpatches) {
            try {
                unpatch();
            } catch {}
        }

        unpatches = [];

        edits.clear();

        logger.log("Local Message Editor unloaded");
    },
};
