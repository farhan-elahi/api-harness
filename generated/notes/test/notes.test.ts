import { describe, expect, it } from "vitest";
import { as } from "./helpers.ts";

type Note = { id: string; title: string; body: string | null };
type Page = { data: Note[]; next_cursor: string | null };

describe("/v1/notes", () => {
  it("create, cursor list, and get are scoped to the workspace", async () => {
    const member = as("notes1", "member");
    expect((await member("POST", "/v1/notes", { title: "a", body: "alpha" }, { "Idempotency-Key": "n1" })).status).toBe(201);
    expect((await member("POST", "/v1/notes", { title: "b" }, { "Idempotency-Key": "n2" })).status).toBe(201);

    const first = (await (await member("GET", "/v1/notes?limit=1")).json()) as Page;
    expect(first.data).toHaveLength(1);
    const fetched = (await (await member("GET", `/v1/notes/${first.data[0]?.id}`)).json()) as Note;
    expect(fetched).toMatchObject({ id: first.data[0]?.id, title: first.data[0]?.title });
    const second = (await (await member("GET", `/v1/notes?limit=1&cursor=${first.next_cursor}`)).json()) as Page;
    expect(second.data).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(((await (await as("notes2", "viewer")("GET", "/v1/notes")).json()) as Page).data).toEqual([]);
  });

  it("enforces roles, duplicate title conflicts, and delete semantics", async () => {
    const owner = as("notes3", "owner");
    const created = (await (await owner("POST", "/v1/notes", { title: "unique" }, { "Idempotency-Key": "n3" })).json()) as Note;
    const duplicate = await owner("POST", "/v1/notes", { title: "unique" }, { "Idempotency-Key": "n4" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("Content-Type")).toBe("application/problem+json");
    expect((await as("notes3", "viewer")("POST", "/v1/notes", { title: "x" }, { "Idempotency-Key": "n5" })).status).toBe(403);
    expect((await as("notes3", "member")("DELETE", `/v1/notes/${created.id}`)).status).toBe(403);
    expect((await owner("DELETE", `/v1/notes/${created.id}`)).status).toBe(204);
    expect((await owner("GET", `/v1/notes/${created.id}`)).status).toBe(404);
  });
});
