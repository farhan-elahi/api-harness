import { Hono } from "hono";
import { authenticate, type AppEnv } from "./lib/auth.ts";
import { onError } from "./lib/errors.ts";
import { widgetsRouter } from "./routes/widgets.ts";

export const app = new Hono<AppEnv>(); // no app.notFound(): ✗ problem-json (reported as missing)
app.onError(onError);
app.route("/v1/widgets", widgetsRouter);
app.use("*", authenticate({ public: [] }));
app.get("/health", (c) => c.text("ok")); // ✗ rest-conventions
