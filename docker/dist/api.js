"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const cache_1 = require("./cache");
const api = new hono_1.Hono();
function toProperties(data) {
    let result = "";
    for (const key in data) {
        result += `${key}=${data[key]}\n`;
    }
    return result;
}
api.get("/:domain/:library?/:bundle?/:key?", (c) => {
    const domain = c.req.param("domain");
    const library = c.req.param("library");
    const bundle = c.req.param("bundle");
    const key = c.req.param("key");
    const locale = c.req.query("locale");
    const format = c.req.query("format") || "json";
    const cache = (0, cache_1.getCache)();
    if (!cache[domain]) {
        return c.json({ error: "Domain not found" }, 404);
    }
    const result = {};
    const librariesToProcess = library ? [library] : Object.keys(cache[domain]);
    for (const lib of librariesToProcess) {
        if (!cache[domain][lib])
            continue;
        const bundlesToProcess = bundle
            ? [bundle]
            : Object.keys(cache[domain][lib]);
        for (const bndl of bundlesToProcess) {
            if (!cache[domain][lib][bndl])
                continue;
            const localesToProcess = locale
                ? [locale]
                : Object.keys(cache[domain][lib][bndl]);
            for (const loc of localesToProcess) {
                if (!cache[domain][lib][bndl][loc])
                    continue;
                const translations = cache[domain][lib][bndl][loc];
                if (!result[loc]) {
                    result[loc] = {};
                }
                if (key) {
                    if (translations[key] !== undefined) {
                        result[loc][key] = translations[key];
                    }
                }
                else {
                    Object.assign(result[loc], translations);
                }
            }
        }
    }
    // If a specific locale was requested, flatten the response
    let finalResult = result;
    if (locale) {
        finalResult = result[locale] || {};
    }
    if (format === "properties") {
        if (locale) {
            return c.text(toProperties(finalResult));
        }
        else {
            // If no locale specified, we can't easily represent multiple locales in a single properties file
            // We'll just return the first locale or an error
            const firstLocale = Object.keys(result)[0];
            if (firstLocale) {
                return c.text(toProperties(result[firstLocale]));
            }
            return c.text("");
        }
    }
    return c.json(finalResult);
});
exports.default = api;
