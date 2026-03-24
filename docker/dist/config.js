"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PORT = exports.TRANSLATIONS_DIR = void 0;
const path_1 = __importDefault(require("path"));
exports.TRANSLATIONS_DIR = process.env.TRANSLATIONS_DIR || path_1.default.join(process.cwd(), "translations");
exports.PORT = parseInt(process.env.PORT || "5002", 10);
