/**
 * Extensiones que se pueden subir (las de FILE_TYPES en rules.ts), sin
 * dependencias de servidor para usarlas en la web. Un test vigila que coincidan.
 */
export const UPLOAD_EXTENSIONS = ["pdf", "csv", "tsv", "xlsx", "png", "jpg", "jpeg", "gif", "webp", "txt", "md", "json", "xml", "yml", "yaml", "log"];

export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");
