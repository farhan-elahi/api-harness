import { Hono } from "hono";
import { authenticate, type AppEnv } from "./lib/auth.ts";
import { notFound, onError } from "./lib/errors.ts";
import { notesRouter } from "./routes/notes.ts";

export const app = new Hono<AppEnv>();
app.onError(onError);
app.notFound(notFound);
app.use("*", authenticate({ public: [] }));

// Mount resource routers below the auth middleware, e.g. app.route("/v1/<plural>", router);
app.route("/v1/notes", notesRouter);
