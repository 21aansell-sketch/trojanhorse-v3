import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, i18n } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { findInReactTree } from "@vendetta/utils";

type Message = any;

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const Messages = findByProps(
    "sendMessage",
    "startEditMessage",
    "editMessage",
    "endEditMessage",
);

const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");

const ActionSheetRow =
    findByProps("ActionSheetRow")?.ActionSheetRow ??
    Forms.FormRow;

const edits = new Map<string, Message>();

let isEditing = false;
let patches: (() => void)[] = [];


function getMessage(channelId: string, messageId: string, fallback?: Message) {
    try {
        return (
            MessageStore?.getMessage?.(channelId, messageId) ??
            fallback
        );
    } catch {
        return fallback;
    }
}


function isActionSheetRow(node: any): boolean {
    if (!node) return false;

    const type = node?.type;

    if (type === ActionSheetRow) return true;

    const name =
        type?.displayName ??
        type?.name ??
        type?.render?.displayName ??
        type?.render?.name;

    return (
        name === "ActionSheetRow" ||
        name === "FormRow"
    );
}


function findActionSheetButtons(tree: any): any[] | undefined {
    const result = findInReactTree(
        tree,
        (node: any) => {
            if (!Array.isArray(node)) return false;

            return node.some(
                (child: any) =>
                    child?.props &&
                    isActionSheetRow(child),
            );
        },
    );

    return Array.isArray(result) ? result : undefined;
}

export default {
    onLoad() {

        if (LazyActionSheet?.openLazy) {
            patches.push(
                before(
                    "openLazy",
                    LazyActionSheet,
                    ([component, key, msg]) => {
                        if (key !== "MessageLongPressActionSheet") {
                            return;
                        }

                        const message = msg?.message;
                        if (!message?.id || !message?.channel_id) {
                            return;
                        }

                        component?.then?.((instance: any) => {
                            if (!instance) return;

                            const unpatch = after(
                                "default",
                                instance,
                                (_args: any, res: any) => {

                                    setTimeout(() => {
                                        try {
                                            const buttons =
                                                findActionSheetButtons(res);

                                            if (!buttons) return;

                                            const currentUser =
                                                UserStore?.getCurrentUser?.();

                                            const currentMessage =
                                                getMessage(
                                                    message.channel_id,
                                                    message.id,
                                                    message,
                                                );

                                            if (!currentMessage) return;

                                            if (
                                                currentUser?.id &&
                                                currentMessage.author?.id ===
                                                    currentUser.id
                                            ) {
                                                return;
                                            }


                                            if (
                                                buttons.some(
                                                    (button: any) =>
                                                        button?.props
                                                            ?.label ===
                                                        "Edit Locally",
                                                )
                                            ) {
                                                return;
                                            }

                                            const markUnreadIndex =
                                                buttons.findIndex(
                                                    (button: any) =>
                                                        button?.props
                                                            ?.message ===
                                                        i18n.Messages
                                                            .MARK_UNREAD,
                                                );

                                            const position =
                                                markUnreadIndex >= 0
                                                    ? markUnreadIndex
                                                    : Math.max(
                                                          buttons.length - 1,
                                                          0,
                                                      );

                                            const handleEdit = () => {
                                                isEditing = true;

                                                if (
                                                    !edits.has(
                                                        currentMessage.id,
                                                    )
                                                ) {
                                                    edits.set(
                                                        currentMessage.id,
                                                        JSON.parse(
                                                            JSON.stringify(
                                                                currentMessage,
                                                            ),
                                                        ),
                                                    );
                                                }

                                                LazyActionSheet?.hideActionSheet?.();


                                                Messages?.startEditMessage?.(
                                                    currentMessage.channel_id,
                                                    currentMessage.id,
                                                    currentMessage.content ?? "",
                                                );
                                            };

                                            const button = (
                                                <ActionSheetRow
                                                    label="Edit Locally"
                                                    icon={
                                                        <ActionSheetRow.Icon
                                                            source={getAssetIDByName(
                                                                "ic_edit_24px",
                                                            )}
                                                        />
                                                    }
                                                    onPress={handleEdit}
                                                />
                                            );

                                            buttons.splice(
                                                position,
                                                0,
                                                button,
                                            );
                                        } catch (error) {
                                            console.error(
                                                "[LocalEdit] Failed to patch action sheet:",
                                                error,
                                            );
                                        } finally {
                                            unpatch();
                                        }
                                    }, 0);
                                },
                            );
                        });
                    },
                ),
            );
        }


        if (Messages?.editMessage) {
            patches.push(
                before(
                    "editMessage",
                    Messages,
                    (args: any[]) => {
                        if (!isEditing) return;

                        const [channelId, messageId, message] = args;

                        const baseMessage = edits.get(messageId);

                        if (!baseMessage) {
                            isEditing = false;
                            return;
                        }

                        const newContent =
                            typeof message === "string"
                                ? message
                                : message?.content ?? "";

                        FluxDispatcher.dispatch({
                            type: "MESSAGE_UPDATE",
                            message: {
                                ...baseMessage,
                                content: newContent,


                                edited_timestamp: null,
                            },


                            otherPluginBypass: true,
                        });


                        return false;
                    },
                ),
            );
        }


        if (Messages?.endEditMessage) {
            patches.push(
                after(
                    "endEditMessage",
                    Messages,
                    () => {
                        isEditing = false;
                    },
                ),
            );
        }
    },

    onUnload() {
        for (const unpatch of patches) {
            try {
                unpatch();
            } catch {
                // Ignore already-removed patches.
            }
        }

        patches = [];
        edits.clear();
        isEditing = false;
    },
};
