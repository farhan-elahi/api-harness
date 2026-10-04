import { describe, expect, it } from "vitest";
import { as } from "./helpers.ts";

type Page = { data: unknown[]; next_cursor: string | null };

describe("/v1/examples (reference pattern)", () => {
  it("create + cursor list, scoped to the workspace", async () => {
    const owner = as("ex1", "owner");
    for (const name of ["a", "b"]) expect((await owner("POST", "/v1/examples", { name })).status).toBe(201);
    const first = (await (await owner("GET", "/v1/examples?limit=1")).json()) as Page;
    expect(first.data).toHaveLength(1);
    const second = await (await owner("GET", `/v1/examples?limit=1&cursor=${first.next_cursor}`)).json();
    expect(second).toMatchObject({ data: [expect.any(Object)], next_cursor: null });
    expect(((await (await as("ex2", "owner")("GET", "/v1/examples")).json()) as Page).data).toEqual([]);
  });

  it("422 problem+json on bad body, 403 for viewers", async () => {
    const bad = await as("ex1", "member")("POST", "/v1/examples", { name: "" });
    expect(bad.status).toBe(422);
    expect(bad.headers.get("Content-Type")).toBe("application/problem+json");
    expect((await as("ex1", "viewer")("POST", "/v1/examples", { name: "x" })).status).toBe(403);
  });

  it("Idempotency-Key replays the first response", async () => {
    const post = () => as("ex3", "owner")("POST", "/v1/examples", { name: "once" }, { "Idempotency-Key": "k1" });
    const a = await (await post()).json();
    const b = await post();
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await b.json()).toEqual(a);
  });
});
