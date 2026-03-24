import chokidar from "chokidar";
import { TRANSLATIONS_DIR } from "./config";
import fs from "fs/promises";
import path from "path";
import propertiesReader from "properties-reader";

// Cache structure:
// domain -> library -> bundle -> locale -> { key: value }
export type TranslationsCache = Record<
  string,
  Record<string, Record<string, Record<string, Record<string, string>>>>
>;

let cache: TranslationsCache = {};

export const getCache = () => cache;

export const loadTranslations = async () => {
  const newCache: TranslationsCache = {};

  try {
    // Ensure directory exists
    try {
      await fs.access(TRANSLATIONS_DIR);
    } catch {
      console.log(
        `Translations directory ${TRANSLATIONS_DIR} does not exist. Creating it...`,
      );
      await fs.mkdir(TRANSLATIONS_DIR, { recursive: true });
    }

    const domains = await fs.readdir(TRANSLATIONS_DIR, { withFileTypes: true });
    for (const domain of domains) {
      if (!domain.isDirectory()) continue;
      newCache[domain.name] = {};

      const libraries = await fs.readdir(
        path.join(TRANSLATIONS_DIR, domain.name),
        { withFileTypes: true },
      );
      for (const library of libraries) {
        if (!library.isDirectory()) continue;
        newCache[domain.name][library.name] = {};

        const bundles = await fs.readdir(
          path.join(TRANSLATIONS_DIR, domain.name, library.name),
          { withFileTypes: true },
        );
        for (const bundle of bundles) {
          if (!bundle.isDirectory()) continue;
          newCache[domain.name][library.name][bundle.name] = {};

          const files = await fs.readdir(
            path.join(TRANSLATIONS_DIR, domain.name, library.name, bundle.name),
            { withFileTypes: true },
          );
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith(".properties")) continue;

            // Extract locale from bundle_nn_NN.properties
            // e.g., messages_en_US.properties -> en_US
            const match = file.name.match(
              /^.*_([a-z]{2}_[A-Z]{2})\.properties$/,
            );
            if (!match) continue;

            const locale = match[1];
            const filePath = path.join(
              TRANSLATIONS_DIR,
              domain.name,
              library.name,
              bundle.name,
              file.name,
            );

            try {
              const properties = propertiesReader({ sourceFile: filePath });
              const data: Record<string, string> = {};
              properties.each((key, value) => {
                data[key] = String(value);
              });
              newCache[domain.name][library.name][bundle.name][locale] = data;
            } catch (err) {
              console.error(`Error reading properties file ${filePath}:`, err);
            }
          }
        }
      }
    }
    cache = newCache;
    console.log("Translations cache loaded successfully.");
  } catch (err) {
    console.error("Error loading translations:", err);
  }
};

let reloadTimeout: NodeJS.Timeout | null = null;

export const initWatcher = () => {
  const watcher = chokidar.watch(TRANSLATIONS_DIR, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("all", (event, filePath) => {
    console.log(
      `File ${filePath} has been ${event}. Scheduling cache reload...`,
    );
    if (reloadTimeout) {
      clearTimeout(reloadTimeout);
    }
    reloadTimeout = setTimeout(() => {
      loadTranslations();
    }, 500);
  });
};
