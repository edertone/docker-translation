import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { PORT } from "./config";
import { loadTranslations, initWatcher } from "./cache";
import api from "./api";

const app = new Hono();

app.get("/", (c) => c.text("Translation Service is running."));

app.route("/", api);

async function start() {
  await loadTranslations();
  initWatcher();

  serve(
    {
      fetch: app.fetch,
      port: PORT,
    },
    (info) => {
      console.log(
        `Translation service is running on http://localhost:${info.port}`,
      );
    },
  );
}

start().catch(console.error);
