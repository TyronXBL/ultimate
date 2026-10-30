import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineExtension } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { implementAction } from "../../lib/actions.ts";
import { InputsAction } from "./refs.ts";

const size = 64;

/** An input with its words only: its images are most of its size, and the pin shows none. */
function withoutImages(entry: EntryRecord): EntryRecord {
  if (!entry.model) return entry;
  return {
    ...entry,
    model: entry.model.map((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.filter((block) => block.type !== "image"),
          }
        : message,
    ),
  };
}

export const actions = {
  // The store is scanned here so the browser receives a page of inputs, not every entry between them.
  inputs: implementAction(InputsAction, async (args, { host }) => {
    const { conversation: id, before } = (args ?? {}) as {
      conversation?: unknown;
      before?: unknown;
    };
    if (
      !Number.isSafeInteger(id) ||
      typeof before !== "number" ||
      !Number.isSafeInteger(before)
    )
      throw new Error("Expected { conversation, before } as ids");
    const conversation = await host
      .harness()
      .conversation(id as ConversationId, context);
    if (!conversation) throw new Error("Unknown conversation");
    const inputs: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries(
        { maxEntryId: (before - 1) as EntryId },
        512,
        cursor,
        context,
      );
      const own = page.items.findIndex(
        (entry) => entry.conversationId !== conversation.id,
      );
      inputs.push(
        ...page.items
          .slice(0, own < 0 ? undefined : own)
          .filter((entry) => entry.input),
      );
      cursor = own < 0 ? page.next : undefined;
    } while (cursor && inputs.length <= size);
    const entries = inputs.slice(0, size);
    return {
      entries: entries.map(withoutImages),
      before: inputs.length > size ? entries.at(-1)!.id : undefined,
    };
  }),
};

export default () => defineExtension({ name: "pinned-turn" });
