import { describe, expect, it } from "vitest";
import { as } from "./helpers.ts";

const owner = as("w1", "owner");
const member = as("w1", "member");
const viewer = as("w1", "viewer");
const other = as("w2", "owner");
const PROBLEM = "application/problem+json";

describe("tasks", () => {
  it("creates (201), reads, updates, deletes (204), then 404", async () => {
    const created = await member("POST", "/v1/tasks", { title: "a" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await viewer("GET", `/v1/tasks/${id}`)).status).toBe(200);
    const patched = await member("PATCH", `/v1/tasks/${id}`, { body: "b" });
    expect(await patched.json()).toMatchObject({ id, title: "a", body: "b" });
    expect((await owner("DELETE", `/v1/tasks/${id}`)).status).toBe(204);
    const gone = await owner("GET", `/v1/tasks/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("Content-Type")).toBe(PROBLEM);
  });

  it("409 on duplicate title in a workspace, allowed across workspaces", async () => {
    expect((await owner("POST", "/v1/tasks", { title: "dup" })).status).toBe(201);
    const dup = await owner("POST", "/v1/tasks", { title: "dup" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ type: "about:blank", title: "Conflict", status: 409, instance: "/v1/tasks" });
    expect((await other("POST", "/v1/tasks", { title: "dup" })).status).toBe(201);
  });

  it("422 problem+json on invalid body, params and query", async () => {
    for (const res of [
      await owner("POST", "/v1/tasks", { title: "" }),
      await owner("GET", "/v1/tasks/not-a-uuid"),
      await owner("GET", "/v1/tasks?limit=0"),
    ]) {
      expect(res.status).toBe(422);
      expect(res.headers.get("Content-Type")).toBe(PROBLEM);
    }
  });

  it("enforces roles: viewer cannot write, member cannot delete", async () => {
    expect((await viewer("POST", "/v1/tasks", { title: "v" })).status).toBe(403);
    const { id } = (await (await owner("POST", "/v1/tasks", { title: "r" })).json()) as { id: string };
    expect((await member("DELETE", `/v1/tasks/${id}`)).status).toBe(403);
  });

  it("isolates workspaces", async () => {
    const { id } = (await (await owner("POST", "/v1/tasks", { title: "secret" })).json()) as { id: string };
    expect((await other("GET", `/v1/tasks/${id}`)).status).toBe(404);
    expect((await other("DELETE", `/v1/tasks/${id}`)).status).toBe(404);
    const list = (await (await other("GET", "/v1/tasks")).json()) as { data: { id: string }[] };
    expect(list.data.map((n) => n.id)).not.toContain(id);
  });

  it("paginates with a cursor", async () => {
    const p = as("w3", "owner");
    for (const t of ["x1", "x2", "x3"]) await p("POST", "/v1/tasks", { title: t });
    const first = (await (await p("GET", "/v1/tasks?limit=2")).json()) as { data: unknown[]; next_cursor: string | null };
    expect(first.data).toHaveLength(2);
    const second = (await (await p("GET", `/v1/tasks?limit=2&cursor=${first.next_cursor}`)).json()) as typeof first;
    expect(second.data).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it("replays POST with the same Idempotency-Key", async () => {
    const h = { "Idempotency-Key": "k1" };
    const a = await owner("POST", "/v1/tasks", { title: "idem" }, h);
    const b = await owner("POST", "/v1/tasks", { title: "idem" }, h);
    expect(b.status).toBe(201);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    expect((await owner("POST", "/v1/tasks", { title: "other" }, h)).status).toBe(422);
  });
});
