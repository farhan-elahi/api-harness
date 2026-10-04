import { describe, expect, it } from "vitest";
import { as } from "./helpers.ts";

const owner = as("w1", "owner");
const member = as("w1", "member");
const viewer = as("w1", "viewer");
const other = as("w2", "owner");
const PROBLEM = "application/problem+json";

describe("notes", () => {
  it("creates (201), reads, updates, deletes (204), then 404", async () => {
    const created = await member("POST", "/v1/notes", { title: "a" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await viewer("GET", `/v1/notes/${id}`)).status).toBe(200);
    const patched = await member("PATCH", `/v1/notes/${id}`, { body: "b" });
    expect(await patched.json()).toMatchObject({ id, title: "a", body: "b" });
    expect((await owner("DELETE", `/v1/notes/${id}`)).status).toBe(204);
    const gone = await owner("GET", `/v1/notes/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("Content-Type")).toBe(PROBLEM);
  });

  it("409 on duplicate title in a workspace, allowed across workspaces", async () => {
    expect((await owner("POST", "/v1/notes", { title: "dup" })).status).toBe(201);
    const dup = await owner("POST", "/v1/notes", { title: "dup" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ type: "about:blank", title: "Conflict", status: 409, instance: "/v1/notes" });
    expect((await other("POST", "/v1/notes", { title: "dup" })).status).toBe(201);
  });

  it("422 problem+json on invalid body, params and query", async () => {
    for (const res of [
      await owner("POST", "/v1/notes", { title: "" }),
      await owner("GET", "/v1/notes/not-a-uuid"),
      await owner("GET", "/v1/notes?limit=0"),
    ]) {
      expect(res.status).toBe(422);
      expect(res.headers.get("Content-Type")).toBe(PROBLEM);
    }
  });

  it("enforces roles: viewer cannot write, member cannot delete", async () => {
    expect((await viewer("POST", "/v1/notes", { title: "v" })).status).toBe(403);
    const { id } = (await (await owner("POST", "/v1/notes", { title: "r" })).json()) as { id: string };
    expect((await member("DELETE", `/v1/notes/${id}`)).status).toBe(403);
  });

  it("isolates workspaces", async () => {
    const { id } = (await (await owner("POST", "/v1/notes", { title: "secret" })).json()) as { id: string };
    expect((await other("GET", `/v1/notes/${id}`)).status).toBe(404);
    expect((await other("DELETE", `/v1/notes/${id}`)).status).toBe(404);
    const list = (await (await other("GET", "/v1/notes")).json()) as { data: { id: string }[] };
    expect(list.data.map((n) => n.id)).not.toContain(id);
  });

  it("paginates with a cursor", async () => {
    const p = as("w3", "owner");
    for (const t of ["x1", "x2", "x3"]) await p("POST", "/v1/notes", { title: t });
    const first = (await (await p("GET", "/v1/notes?limit=2")).json()) as { data: unknown[]; next_cursor: string | null };
    expect(first.data).toHaveLength(2);
    const second = (await (await p("GET", `/v1/notes?limit=2&cursor=${first.next_cursor}`)).json()) as typeof first;
    expect(second.data).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it("replays POST with the same Idempotency-Key", async () => {
    const h = { "Idempotency-Key": "k1" };
    const a = await owner("POST", "/v1/notes", { title: "idem" }, h);
    const b = await owner("POST", "/v1/notes", { title: "idem" }, h);
    expect(b.status).toBe(201);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    expect((await owner("POST", "/v1/notes", { title: "other" }, h)).status).toBe(422);
  });
});
