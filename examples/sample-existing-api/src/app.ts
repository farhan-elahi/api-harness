import { Hono } from "hono";
import { authenticate, type AppEnv } from "./lib/auth.ts";
import { notFound, onError } from "./lib/errors.ts";
import { tasksRouter } from "./routes/tasks.ts";

export const app = new Hono<AppEnv>();
app.onError(onError);
app.notFound(notFound);
app.use("*", authenticate({ public: [] }));

app.route("/v1/tasks", tasksRouter);
