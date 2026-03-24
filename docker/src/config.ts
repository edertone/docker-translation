import path from "path";

export const TRANSLATIONS_DIR =
  process.env.TRANSLATIONS_DIR || path.join(process.cwd(), "translations");
export const PORT = parseInt(process.env.PORT || "5002", 10);
