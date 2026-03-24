"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_server_1 = require("@hono/node-server");
const hono_1 = require("hono");
const config_1 = require("./config");
const cache_1 = require("./cache");
const api_1 = __importDefault(require("./api"));
const app = new hono_1.Hono();
app.get("/", (c) => c.text("Translation Service is running."));
app.route("/api/translations", api_1.default);
async function start() {
    await (0, cache_1.loadTranslations)();
    (0, cache_1.initWatcher)();
    (0, node_server_1.serve)({
        fetch: app.fetch,
        port: config_1.PORT,
    }, (info) => {
        console.log(`Translation service is running on http://localhost:${info.port}`);
    });
}
start().catch(console.error);
