import type { EntryId } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import type { InputsPage } from "../extensions/pinned-turn/refs.ts";
import { context } from "../server/harness.ts";
import { fauxServer, post, temp, trimmedSourceCopy } from "./helpers.ts";

it("reads only the inputs below a cursor, without their images", async () => {
  const home = await temp("ultimate-pinned-turn-");
  const ultimateRoot = await trimmedSourceCopy(home, ["pinned-turn"]);
  const server = await fauxServer({ ultimateRoot, home, userHome: home });
  try {
    const inputs = await server.harness.commit(async (tx) => {
      const rows: EntryId[] = [];
      for (let n = 0; n < 3; n++) {
        rows.push(
          (
            await tx.appendEntry(server.root.id, {
              kind: "pi.user",
              input: true,
              model: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: `Turn ${n}` },
                    {
                      type: "image",
                      data: "A".repeat(100_000),
                      mimeType: "image/png",
                    },
                  ],
                  timestamp: n,
                },
              ],
            })
          ).id,
        );
        // More rows between two inputs than one page of the store holds.
        for (let step = 0; step < 700; step++)
          await tx.appendEntry(server.root.id, {
            kind: "test.step",
            data: { step },
          });
      }
      return rows;
    }, context);
    const { status, data } = await post(
      server,
      "/api/extensions/pinned-turn/actions/inputs",
      {
        args: { conversation: server.root.id, before: inputs[2] },
      },
    );
    expect(status).toBe(200);
    const page = data.result as InputsPage;
    expect(page.entries.map((entry) => entry.id)).toEqual(
      inputs.slice(0, 2).toReversed(),
    );
    expect(page.before).toBeUndefined();
    // Their words only: the images stay on the server.
    expect(page.entries[0].model).toMatchObject([
      { content: [{ type: "text", text: "Turn 1" }] },
    ]);
    expect(JSON.stringify(page).length).toBeLessThan(2_000);
  } finally {
    await server.close();
  }
});
