"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initWatcher = exports.loadTranslations = exports.getCache = void 0;
const chokidar_1 = __importDefault(require("chokidar"));
const config_1 = require("./config");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const properties_reader_1 = __importDefault(require("properties-reader"));
let cache = {};
const getCache = () => cache;
exports.getCache = getCache;
const loadTranslations = async () => {
    const newCache = {};
    try {
        // Ensure directory exists
        try {
            await promises_1.default.access(config_1.TRANSLATIONS_DIR);
        }
        catch {
            console.log(`Translations directory ${config_1.TRANSLATIONS_DIR} does not exist. Creating it...`);
            await promises_1.default.mkdir(config_1.TRANSLATIONS_DIR, { recursive: true });
        }
        const domains = await promises_1.default.readdir(config_1.TRANSLATIONS_DIR, { withFileTypes: true });
        for (const domain of domains) {
            if (!domain.isDirectory())
                continue;
            newCache[domain.name] = {};
            const libraries = await promises_1.default.readdir(path_1.default.join(config_1.TRANSLATIONS_DIR, domain.name), { withFileTypes: true });
            for (const library of libraries) {
                if (!library.isDirectory())
                    continue;
                newCache[domain.name][library.name] = {};
                const bundles = await promises_1.default.readdir(path_1.default.join(config_1.TRANSLATIONS_DIR, domain.name, library.name), { withFileTypes: true });
                for (const bundle of bundles) {
                    if (!bundle.isDirectory())
                        continue;
                    newCache[domain.name][library.name][bundle.name] = {};
                    const files = await promises_1.default.readdir(path_1.default.join(config_1.TRANSLATIONS_DIR, domain.name, library.name, bundle.name), { withFileTypes: true });
                    for (const file of files) {
                        if (!file.isFile() || !file.name.endsWith(".properties"))
                            continue;
                        // Extract locale from bundle_nn_NN.properties
                        // e.g., messages_en_US.properties -> en_US
                        const match = file.name.match(/^.*_([a-z]{2}_[A-Z]{2})\.properties$/);
                        if (!match)
                            continue;
                        const locale = match[1];
                        const filePath = path_1.default.join(config_1.TRANSLATIONS_DIR, domain.name, library.name, bundle.name, file.name);
                        try {
                            const properties = (0, properties_reader_1.default)({ sourceFile: filePath });
                            const data = {};
                            properties.each((key, value) => {
                                data[key] = String(value);
                            });
                            newCache[domain.name][library.name][bundle.name][locale] = data;
                        }
                        catch (err) {
                            console.error(`Error reading properties file ${filePath}:`, err);
                        }
                    }
                }
            }
        }
        cache = newCache;
        console.log("Translations cache loaded successfully.");
    }
    catch (err) {
        console.error("Error loading translations:", err);
    }
};
exports.loadTranslations = loadTranslations;
let reloadTimeout = null;
const initWatcher = () => {
    const watcher = chokidar_1.default.watch(config_1.TRANSLATIONS_DIR, {
        persistent: true,
        ignoreInitial: true,
    });
    watcher.on("all", (event, filePath) => {
        console.log(`File ${filePath} has been ${event}. Scheduling cache reload...`);
        if (reloadTimeout) {
            clearTimeout(reloadTimeout);
        }
        reloadTimeout = setTimeout(() => {
            (0, exports.loadTranslations)();
        }, 500);
    });
};
exports.initWatcher = initWatcher;
