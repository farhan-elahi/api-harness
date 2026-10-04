import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { as } from "./helpers.ts";

describe("template base", () => {
  it("401 problem+json without a token", async () => {
    const res = await app.request("/v1/anything");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ type: "about:blank", title: "Unauthorized", status: 401, instance: "/v1/anything" });
  });

  it("404 problem+json for unknown routes", async () => {
    const res = await as("w1", "owner")("GET", "/v1/nothing-here");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await res.json()).toMatchObject({ title: "Not Found", status: 404, detail: expect.any(String) });
  });
});
