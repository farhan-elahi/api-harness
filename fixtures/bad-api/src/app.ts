import { Hono } from "hono";
import { authenticate, type AppEnv } from "./lib/auth.ts";
import { onError } from "./lib/errors.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { examplesRouter } from "./routes/_example.ts";

export const app = new Hono<AppEnv>(); // no app.notFound(): ✗ problem-json (reported as missing)
app.onError(onError);
app.route("/v1/widgets", widgetsRouter);
app.use("*", authenticate({ public: [] }));
app.route("/v1/examples", examplesRouter);
app.get("/health", (c) => c.text("ok")); // ✗ rest-conventions
